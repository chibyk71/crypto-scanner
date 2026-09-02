// src/lib/watchAlerts/index.ts
// WatchAlertService — public API for create / evaluate / list.

import { config } from '../../config/settings';
import { dbService } from '../../db';
import { createLogger } from '../../logger';
import type { ExchangeService } from '../exchange';

import { evaluateConditionTree, evaluateLeavesProgress } from './conditions/evaluateConditionTree';
import { SeriesCache } from './conditions/seriesCache';
import { MAX_CONCURRENT_ACTIVE_ALERTS } from './constants';
import {
    asConditionNode,
    clampExpiryHours,
    parseWatchAlertJson,
} from './schema';
import { resolveTradePlan } from './tradePlan/resolveTradePlan';
import { validateTradePlan } from './tradePlan/validateTradePlan';
import type {
    EvaluationResult,
    WatchAlert,
    WatchAlertCreateResult,
    WatchAlertJsonInput,
    WatchAlertProgress,
    WatchAlertValidationError,
} from './types';

const logger = createLogger('WatchAlertService');

/** Pending validated payload awaiting user confirm in Telegram */
export interface PendingWatchAlert {
    chatId: number;
    payload: WatchAlertJsonInput;
    expiresAtMs: number;
    createdAtMs: number;
}

export class WatchAlertService {
    /** In-memory pending pastes awaiting confirm (keyed by chatId) */
    private readonly pending = new Map<number, PendingWatchAlert>();

    constructor(private readonly exchange: ExchangeService) { }

    /**
     * Validate raw JSON string, enforce concurrent cap, persist, return result.
     * Does NOT require a confirm step — callers that want confirm should use
     * stagePending + confirmPending instead.
     */
    async createFromJson(rawJsonString: string): Promise<WatchAlertCreateResult> {
        const parsed = parseWatchAlertJson(rawJsonString);
        if (!parsed.ok) {
            return { ok: false, errors: parsed.errors };
        }

        return this.persistValidated(parsed.data);
    }

    /**
     * Validate + stage for Telegram confirm (does not write to DB yet).
     */
    async stageFromJson(
        chatId: number,
        rawJsonString: string
    ): Promise<WatchAlertCreateResult | { ok: true; pending: PendingWatchAlert }> {
        const parsed = parseWatchAlertJson(rawJsonString);
        if (!parsed.ok) {
            return { ok: false, errors: parsed.errors };
        }

        // Snapshot ATR validation before staging
        const tradePlanCheck = await this.validatePlanAgainstMarket(parsed.data);
        if (!tradePlanCheck.ok) {
            return {
                ok: false,
                errors: [{ field: 'tradePlan', message: tradePlanCheck.reason! }],
            };
        }

        const activeCount = await dbService.countActiveWatchAlerts();
        if (activeCount >= MAX_CONCURRENT_ACTIVE_ALERTS) {
            return {
                ok: false,
                errors: [
                    {
                        field: '',
                        message: `Already at max concurrent active alerts (${MAX_CONCURRENT_ACTIVE_ALERTS})`,
                    },
                ],
            };
        }

        const now = Date.now();
        const expiryHours = clampExpiryHours(parsed.data.expiryHours);
        const pending: PendingWatchAlert = {
            chatId,
            payload: {
                ...parsed.data,
                entry: asConditionNode(parsed.data.entry),
                invalidate: parsed.data.invalidate
                    ? asConditionNode(parsed.data.invalidate)
                    : null,
            },
            expiresAtMs: now + expiryHours * 60 * 60 * 1000,
            createdAtMs: now,
        };
        this.pending.set(chatId, pending);
        return { ok: true, pending };
    }

    /**
     * Confirm a staged pending alert → persist.
     */
    async confirmPending(chatId: number): Promise<WatchAlertCreateResult> {
        const pending = this.pending.get(chatId);
        if (!pending) {
            return {
                ok: false,
                errors: [{ field: '', message: 'No pending watch alert to confirm' }],
            };
        }
        this.pending.delete(chatId);
        return this.persistValidated(pending.payload, pending);
    }

    /** Discard staged pending alert */
    cancelPending(chatId: number): boolean {
        return this.pending.delete(chatId);
    }

    getPending(chatId: number): PendingWatchAlert | undefined {
        return this.pending.get(chatId);
    }

    /**
     * Evaluate all active alerts. Returns events for the caller to message on.
     * Fire-once: triggered / invalidated / expired are terminal.
     */
    async evaluateActiveAlerts(): Promise<EvaluationResult[]> {
        const alerts = await dbService.getActiveWatchAlerts();
        const now = Date.now();
        const results: EvaluationResult[] = [];

        for (const alert of alerts) {
            try {
                // 1. Hard expiry first
                if (now >= alert.expiresAt) {
                    await dbService.updateWatchAlertStatus(alert.id, 'expired', {
                        resolvedAt: now,
                        resolvedReason: 'expired',
                    });
                    results.push({
                        alert: { ...alert, status: 'expired', resolvedAt: now, resolvedReason: 'expired' },
                        event: 'expired',
                    });
                    continue;
                }

                const cache = new SeriesCache(this.exchange, alert.symbol);

                // 2. Invalidate tree (if present) — quieter path
                if (alert.invalidateConditions) {
                    const inv = await evaluateConditionTree(
                        alert.invalidateConditions,
                        cache
                    );
                    if (inv.met) {
                        await dbService.updateWatchAlertStatus(alert.id, 'invalidated', {
                            resolvedAt: now,
                            resolvedReason: 'invalidated',
                        });
                        results.push({
                            alert: {
                                ...alert,
                                status: 'invalidated',
                                resolvedAt: now,
                                resolvedReason: 'invalidated',
                            },
                            event: 'invalidated',
                            reasons: inv.reasons,
                        });
                        continue;
                    }
                }

                // 3. Entry tree
                const entry = await evaluateConditionTree(alert.entryConditions, cache);
                if (entry.met) {
                    const primaryTf = config.scanner.primaryTimeframe;
                    const price =
                        (await cache.getLastClose(primaryTf)) ??
                        (await cache.getLastClose('1h'));
                    const atr =
                        (await cache.getLastAtr(primaryTf)) ??
                        (await cache.getLastAtr('1h'));

                    if (price === null || atr === null) {
                        logger.debug('Entry met but missing price/ATR — deferring', {
                            id: alert.id,
                            symbol: alert.symbol,
                        });
                        continue;
                    }

                    const resolvedPlan = resolveTradePlan(alert.tradePlan, price, atr);

                    await dbService.updateWatchAlertStatus(alert.id, 'triggered', {
                        resolvedAt: now,
                        resolvedReason: 'entry_hit',
                        triggeredPrice: price,
                    });

                    results.push({
                        alert: {
                            ...alert,
                            status: 'triggered',
                            resolvedAt: now,
                            resolvedReason: 'entry_hit',
                            triggeredPrice: price,
                        },
                        event: 'triggered',
                        resolvedPlan,
                        reasons: entry.reasons,
                    });
                }
            } catch (err) {
                logger.error('evaluateActiveAlerts failed for alert', {
                    id: alert.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return results;
    }

    /**
     * Active alerts with per-leaf progress for /watchlist.
     */
    async listActive(): Promise<WatchAlertProgress[]> {
        const alerts = await dbService.getActiveWatchAlerts();
        const out: WatchAlertProgress[] = [];

        for (const alert of alerts) {
            try {
                const cache = new SeriesCache(this.exchange, alert.symbol);
                const leaves = await evaluateLeavesProgress(
                    alert.entryConditions,
                    cache
                );
                const metCount = leaves.filter((l) => l.met).length;
                out.push({
                    alert,
                    leaves,
                    metCount,
                    totalCount: leaves.length,
                });
            } catch (err) {
                logger.debug('listActive progress failed', {
                    id: alert.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                out.push({
                    alert,
                    leaves: [],
                    metCount: 0,
                    totalCount: 0,
                });
            }
        }

        return out;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private async validatePlanAgainstMarket(
        data: WatchAlertJsonInput
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        try {
            const tf = config.scanner.primaryTimeframe;
            const ohlcv = await this.exchange.getOHLCV(
                data.symbol,
                tf,
                undefined,
                undefined,
                true
            );
            if (!ohlcv || ohlcv.closes.length < 50) {
                return {
                    ok: false,
                    reason: `Insufficient market data for ${data.symbol} on ${tf}`,
                };
            }

            // Lightweight ATR snapshot via computeIndicators
            const { computeIndicators } = await import('../../utils/indicatorUtils');
            const map = computeIndicators(ohlcv, ohlcv);
            const price = map.last.close;
            const atr = map.last.atr;

            const result = validateTradePlan(data.tradePlan, price, atr);
            if (!result.ok) {
                return { ok: false, reason: result.reason! };
            }
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                reason: `Trade-plan market validation failed: ${err instanceof Error ? err.message : String(err)
                    }`,
            };
        }
    }

    private async persistValidated(
        data: WatchAlertJsonInput,
        pending?: PendingWatchAlert
    ): Promise<WatchAlertCreateResult> {
        // Re-check concurrent cap at write time
        const activeCount = await dbService.countActiveWatchAlerts();
        if (activeCount >= MAX_CONCURRENT_ACTIVE_ALERTS) {
            return {
                ok: false,
                errors: [
                    {
                        field: '',
                        message: `Already at max concurrent active alerts (${MAX_CONCURRENT_ACTIVE_ALERTS})`,
                    },
                ],
            } satisfies WatchAlertValidationError;
        }

        // Validate trade plan against live market unless already staged
        if (!pending) {
            const tradePlanCheck = await this.validatePlanAgainstMarket(data);
            if (!tradePlanCheck.ok) {
                return {
                    ok: false,
                    errors: [{ field: 'tradePlan', message: tradePlanCheck.reason! }],
                };
            }
        }

        const now = pending?.createdAtMs ?? Date.now();
        const expiresAt =
            pending?.expiresAtMs ??
            now + clampExpiryHours(data.expiryHours) * 60 * 60 * 1000;

        const id = await dbService.createWatchAlert({
            symbol: data.symbol,
            thesis: data.thesis,
            confidence: data.confidence,
            status: 'active',
            entryConditions: data.entry,
            invalidateConditions: data.invalidate,
            tradePlan: data.tradePlan,
            createdAt: now,
            expiresAt,
            resolvedAt: null,
            resolvedReason: null,
            triggeredPrice: null,
        });

        const alert: WatchAlert = {
            id,
            symbol: data.symbol,
            thesis: data.thesis,
            confidence: data.confidence,
            status: 'active',
            entryConditions: data.entry,
            invalidateConditions: data.invalidate,
            tradePlan: data.tradePlan,
            createdAt: now,
            expiresAt,
            resolvedAt: null,
            resolvedReason: null,
            triggeredPrice: null,
        };

        logger.info('Watch alert created', { id, symbol: data.symbol });
        return { ok: true, alert };
    }
}
