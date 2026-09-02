// src/lib/strategy/risk/riskParams.ts

import type {
    PartialTPLevel,
    TradeSignal,
} from '../../../types';
import { config } from '../../config/settings';
import { createLogger } from '../../logger';
import {
    MAX_ATR_MULTIPLIER,
    MIN_ATR_MULTIPLIER,
} from '../constants';
import type { TrendAndVolume } from '../types';

const logger = createLogger('Strategy');

// =========================================================================
// RISK MANAGEMENT: Dynamic SL/TP, trailing, and position sizing
// =========================================================================
/**
 * Calculates all risk parameters for a valid signal using 2025 scalping best practices.
 *
 * Called from:
 *   • generateSignal() – after signal confirmation
 *
 * Key Features:
 *   • Trend-aware base risk (0.5% bull/neutral, 0.25% bear)
 *   • Confidence scaling (70-100% → up to +0.5% extra risk)
 *   • ATR-based stop distance with safety clamping
 *   • Hard 5× leverage cap
 *   • Aggressive trailing (75% of risk distance)
 *   • Backward-compatible multiplier for legacy systems
 *
 * @param signal - 'buy' or 'sell'
 * @param price - Entry price
 * @param atrMultiplier - Configured ATR multiple
 * @param riskRewardTarget - Target R:R
 * @param confidence - Final signal confidence (0-100)
 * @param lastAtr - Current ATR
 * @param trendBias - HTF trend direction
 * @param accountBalance - Current account equity (defaults to $1000 for testing)
 * @returns Complete risk parameters
 */
export function computeRiskParams(
    signal: TradeSignal['signal'],
    price: number,
    atrMultiplier: number,
    riskRewardTarget: number,
    confidence: number,
    lastAtr: number,
    trendBias: TrendAndVolume['trendBias'],
    accountBalance: number | undefined = 1000,
    requireAtrFeasibility: boolean = true
): {
    stopLoss?: number;
    takeProfit?: number;
    trailingStopDistance?: number;
    positionSizeUsd: number;
    positionSizeMultiplier?: number;
    riskAmountUsd: number;
    takeProfitLevels: PartialTPLevel[];
    feasible: boolean;
    infeasibleReason?: string;
} {
    // No signal → zero risk
    if (signal === 'hold') {
        logger.info('No signal generated – skipping risk parameter calculation');

        return {
            stopLoss: undefined,
            takeProfit: undefined,
            trailingStopDistance: undefined,
            positionSizeUsd: 0,
            positionSizeMultiplier: 0,
            riskAmountUsd: 0,
            takeProfitLevels: [],
            feasible: false,
        };
    }

    // ──────────────────────────────────────────────────────────────
    // 1. BASE ACCOUNT RISK
    //
    // This controls how much account capital is risked on the trade.
    // It is independent of the SL distance and TP target.
    // ──────────────────────────────────────────────────────────────
    const BASE_RISK_PERCENT_BULL = 0.005;     // 0.50%
    const BASE_RISK_PERCENT_BEAR = 0.0025;    // 0.25%
    const MAX_RISK_BONUS_CONFIDENCE = 0.005;  // +0.50% maximum

    const baseRiskPercent =
        trendBias === 'bearish'
            ? BASE_RISK_PERCENT_BEAR
            : BASE_RISK_PERCENT_BULL;

    // Scale additional account risk with confidence.
    const confidenceFactor = Math.max(
        0,
        Math.min((confidence - 50) / 30, 1)
    );

    const bonusRiskPercent =
        confidenceFactor * MAX_RISK_BONUS_CONFIDENCE;

    const finalRiskPercent =
        baseRiskPercent + bonusRiskPercent;

    const riskAmountUsd =
        accountBalance * finalRiskPercent;

    // ──────────────────────────────────────────────────────────────
    // 2. ATR-BASED STOP DISTANCE
    //
    // The stop remains based on actual market volatility.
    // We do not shrink it to force a particular R:R.
    // ──────────────────────────────────────────────────────────────
    const clampedMultiplier = Math.min(
        Math.max(
            atrMultiplier,
            MIN_ATR_MULTIPLIER
        ),
        MAX_ATR_MULTIPLIER
    );

    const riskDistance =
        lastAtr * clampedMultiplier;

    // Absolute sanity check.
    //
    // This is NOT an R:R feasibility check.
    // It simply prevents obviously abnormal volatility from
    // producing an excessively distant stop-loss.
    const riskDistancePct =
        riskDistance / price;

    if (
        riskDistance <= 0 ||
        !Number.isFinite(riskDistance) ||
        riskDistancePct > 0.10
    ) {
        const reason =
            riskDistance <= 0 ||
                !Number.isFinite(riskDistance)
                ? `Invalid ATR-derived risk distance: ${riskDistance}`
                : `Risk distance ${(riskDistancePct * 100).toFixed(2)}% exceeds 10% absolute cap`;

        logger.info(
            `Risk parameter calculation rejected ${signal} signal: ${reason}`
        );

        return {
            stopLoss: undefined,
            takeProfit: undefined,
            trailingStopDistance: undefined,
            positionSizeUsd: 0,
            positionSizeMultiplier: 0,
            riskAmountUsd: 0,
            takeProfitLevels: [],
            feasible: false,
            infeasibleReason: reason,
        };
    }

    // ──────────────────────────────────────────────────────────────
    // 3. STOP LOSS + TRUE 3R TAKE PROFIT
    //
    // The bot's TP is ALWAYS derived from the configured
    // riskRewardTarget.
    //
    // Example:
    //   riskDistance = 0.2%
    //   riskRewardTarget = 3
    //
    //   SL distance = 0.2%
    //   TP distance = 0.6%
    //
    // Your personal/manual 0.3% profit-taking does NOT belong here.
    // This method defines the strategy's signal and simulation levels.
    // ──────────────────────────────────────────────────────────────
    const stopLoss =
        signal === 'buy'
            ? price - riskDistance
            : price + riskDistance;

    const takeProfitDistance =
        riskDistance * riskRewardTarget;

    const takeProfit =
        signal === 'buy'
            ? price + takeProfitDistance
            : price - takeProfitDistance;

    // ──────────────────────────────────────────────────────────────
    // 4. REMOVE FIXED-TP ATR FEASIBILITY GATE
    //
    // Previously:
    //
    //   fixed 0.3% TP
    //       ÷
    //   ATR stop distance
    //
    // was used to reject signals when the resulting calculated R:R
    // was below minAcceptableRR.
    //
    // That conflicts with the actual strategy because the bot's real
    // TP is already:
    //
    //   riskDistance × riskRewardTarget
    //
    // Therefore the generated signal inherently uses the configured
    // R:R (currently intended to be 3:1).
    //
    // Keep the parameter temporarily for API compatibility, but it no
    // longer affects signal feasibility.
    // ──────────────────────────────────────────────────────────────
    void requireAtrFeasibility;

    // ──────────────────────────────────────────────────────────────
    // 5. POSITION SIZE IN USD
    //
    // Position size adjusts so the account risk remains approximately
    // consistent regardless of ATR stop distance.
    // ──────────────────────────────────────────────────────────────
    const rawPositionSizeUsd =
        riskAmountUsd / riskDistancePct;

    // Hard leverage/notional cap.
    const maxAllowedNotional =
        accountBalance * 5.0;

    const positionSizeUsd = Math.min(
        rawPositionSizeUsd,
        maxAllowedNotional
    );

    // ──────────────────────────────────────────────────────────────
    // 6. PARTIAL TAKE-PROFIT LEVELS
    //
    // Filter against the configured final R multiple.
    //
    // Since the actual final TP is riskRewardTarget × riskDistance,
    // no partial level should exist at or beyond the final target.
    // ──────────────────────────────────────────────────────────────
    const takeProfitLevels: PartialTPLevel[] =
        config.simulation.partialTpLevels
            .filter(
                level =>
                    level.rMultiple < riskRewardTarget
            )
            .map(level => ({
                price:
                    signal === 'buy'
                        ? Number(
                            (
                                price +
                                riskDistance * level.rMultiple
                            ).toFixed(8)
                        )
                        : Number(
                            (
                                price -
                                riskDistance * level.rMultiple
                            ).toFixed(8)
                        ),
                weight: level.weight,
            }));

    // ──────────────────────────────────────────────────────────────
    // 7. TRAILING STOP
    //
    // Uses 75% of the original ATR-derived risk distance.
    // ──────────────────────────────────────────────────────────────
    const trailingStopDistance =
        riskDistance * 0.75;

    // ──────────────────────────────────────────────────────────────
    // 8. LEGACY POSITION SIZE MULTIPLIER
    //
    // Retained for downstream systems that still consume it.
    // ──────────────────────────────────────────────────────────────
    const positionSizeMultiplier =
        Math.min(
            (positionSizeUsd / accountBalance) * 5,
            1.5
        );

    // ──────────────────────────────────────────────────────────────
    // FINAL RESULT
    // ──────────────────────────────────────────────────────────────
    return {
        stopLoss: Number(stopLoss.toFixed(8)),
        takeProfit: Number(takeProfit.toFixed(8)),
        trailingStopDistance: Number(
            trailingStopDistance.toFixed(8)
        ),
        positionSizeUsd: Number(
            positionSizeUsd.toFixed(2)
        ),
        positionSizeMultiplier: Number(
            positionSizeMultiplier.toFixed(3)
        ),
        riskAmountUsd: Number(
            riskAmountUsd.toFixed(2)
        ),
        takeProfitLevels,
        feasible: true,
    };
}
