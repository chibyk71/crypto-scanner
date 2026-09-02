// src/lib/watchAlerts/conditions/evaluateConditionTree.ts
// Recursive AND/OR evaluator for ConditionNode trees.
// Fail-closed: missing series or insufficient history → leaf is false (no throw).

import { createLogger } from '../../../logger';
import {
    type ConditionLeaf,
    type ConditionNode,
    isConditionGroup,
    isConditionLeaf,
    type LeafProgress,
} from '../types';

import { resolveSeries, type SeriesCache } from './seriesCache';

const logger = createLogger('WatchAlerts.Eval');

export interface TreeEvalResult {
    met: boolean;
    reasons: string[];
}

/**
 * Evaluate an entire condition tree against a SeriesCache for one symbol.
 * Distinct timeframes are fetched at most once via the cache.
 */
export async function evaluateConditionTree(
    node: ConditionNode,
    cache: SeriesCache
): Promise<TreeEvalResult> {
    if (isConditionGroup(node)) {
        const childResults: TreeEvalResult[] = [];
        for (const child of node.conditions) {
            childResults.push(await evaluateConditionTree(child, cache));
        }

        if (node.op === 'AND') {
            const met = childResults.every((r) => r.met);
            return {
                met,
                reasons: met
                    ? childResults.flatMap((r) => r.reasons)
                    : [],
            };
        }

        // OR
        const met = childResults.some((r) => r.met);
        return {
            met,
            reasons: met
                ? childResults.filter((r) => r.met).flatMap((r) => r.reasons)
                : [],
        };
    }

    // Leaf
    return evaluateLeaf(node, cache);
}

/**
 * Evaluate a single leaf. Crosses need previous + current on both sides —
 * mirrors alertEvaluator.ts semantics:
 *   crosses_above: prev <= prevTarget && curr > target
 *   crosses_below: prev >= prevTarget && curr < target
 */
async function evaluateLeaf(
    leaf: ConditionLeaf,
    cache: SeriesCache
): Promise<TreeEvalResult> {
    const map = await cache.get(leaf.timeframe);
    if (!map) {
        logger.debug('Leaf false — no series map', {
            indicator: leaf.indicator,
            timeframe: leaf.timeframe,
        });
        return { met: false, reasons: [] };
    }

    const primarySeries = resolveSeries(map, leaf.indicator, leaf.period);
    if (!primarySeries || primarySeries.length < 2) {
        logger.debug('Leaf false — insufficient primary series', {
            indicator: leaf.indicator,
            period: leaf.period,
            length: primarySeries?.length ?? 0,
        });
        return { met: false, reasons: [] };
    }

    const current = primarySeries.at(-1)!;
    const previous = primarySeries.at(-2)!;

    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
        return { met: false, reasons: [] };
    }

    let targetCurrent: number;
    let targetPrevious: number | undefined;
    let targetLabel: string;

    if (typeof leaf.target === 'string') {
        // Target is another indicator key (e.g. "ema_50" or "ema")
        const targetSeries = resolveTargetSeries(map, leaf.target);
        if (!targetSeries || targetSeries.length < 2) {
            logger.debug('Leaf false — insufficient target series', {
                target: leaf.target,
            });
            return { met: false, reasons: [] };
        }
        targetCurrent = targetSeries.at(-1)!;
        targetPrevious = targetSeries.at(-2)!;
        targetLabel = leaf.target;
        if (!Number.isFinite(targetCurrent)) {
            return { met: false, reasons: [] };
        }
    } else if (Array.isArray(leaf.target)) {
        // Range handled only by is_in_range
        targetCurrent = 0;
        targetLabel = `[${leaf.target[0]}, ${leaf.target[1]}]`;
    } else {
        targetCurrent = leaf.target;
        targetLabel = String(leaf.target);
    }

    const indicatorLabel = leaf.period
        ? `${leaf.indicator}_${leaf.period}`
        : leaf.indicator;

    let met = false;
    let reasonText = `${indicatorLabel}(${leaf.timeframe})`;

    switch (leaf.operator) {
        case 'crosses_above': {
            const prevTarget =
                targetPrevious !== undefined ? targetPrevious : targetCurrent;
            met =
                previous <= prevTarget && current > targetCurrent;
            reasonText += ` crosses above ${targetLabel}`;
            break;
        }
        case 'crosses_below': {
            const prevTarget =
                targetPrevious !== undefined ? targetPrevious : targetCurrent;
            met =
                previous >= prevTarget && current < targetCurrent;
            reasonText += ` crosses below ${targetLabel}`;
            break;
        }
        case '>':
            met = current > targetCurrent;
            reasonText += ` is > ${formatNum(targetCurrent)}`;
            break;
        case '<':
            met = current < targetCurrent;
            reasonText += ` is < ${formatNum(targetCurrent)}`;
            break;
        case '>=':
            met = current >= targetCurrent;
            reasonText += ` is >= ${formatNum(targetCurrent)}`;
            break;
        case '<=':
            met = current <= targetCurrent;
            reasonText += ` is <= ${formatNum(targetCurrent)}`;
            break;
        case 'is_in_range': {
            if (Array.isArray(leaf.target) && leaf.target.length === 2) {
                const [min, max] = leaf.target;
                met = current >= min && current <= max;
                reasonText += ` is in range [${formatNum(min)}, ${formatNum(max)}]`;
            }
            break;
        }
        default:
            logger.debug('Leaf false — unknown operator', {
                operator: leaf.operator,
            });
            return { met: false, reasons: [] };
    }

    return {
        met,
        reasons: met ? [reasonText] : [],
    };
}

/**
 * Resolve a string target such as "ema_50", "ema", "close", "rsi_14".
 */
function resolveTargetSeries(
    map: import('../../../utils/indicatorUtils').IndicatorMap,
    target: string
): number[] | undefined {
    const m = /^([a-z_]+)_(\d+)$/i.exec(target);
    if (m) {
        return resolveSeries(map, m[1], parseInt(m[2], 10));
    }
    return resolveSeries(map, target);
}

function formatNum(n: number): string {
    if (Math.abs(n) >= 1000) return n.toFixed(2);
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(6);
}

/**
 * Collect every leaf in the tree (for progress display).
 */
export function collectLeaves(node: ConditionNode): ConditionLeaf[] {
    if (isConditionLeaf(node)) return [node];
    if (isConditionGroup(node)) {
        return node.conditions.flatMap(collectLeaves);
    }
    return [];
}

/**
 * Best-effort per-leaf progress for /watchlist.
 * Uses the same evaluator so results stay consistent with the live gate.
 */
export async function evaluateLeavesProgress(
    node: ConditionNode,
    cache: SeriesCache
): Promise<LeafProgress[]> {
    const leaves = collectLeaves(node);
    const progress: LeafProgress[] = [];

    for (const leaf of leaves) {
        const result = await evaluateLeaf(leaf, cache);
        const label = leaf.period
            ? `${leaf.indicator}_${leaf.period}`
            : leaf.indicator;
        const targetStr = Array.isArray(leaf.target)
            ? `[${leaf.target[0]}, ${leaf.target[1]}]`
            : String(leaf.target);
        progress.push({
            description: `${label}(${leaf.timeframe}) ${leaf.operator} ${targetStr}`,
            met: result.met,
        });
    }

    return progress;
}
