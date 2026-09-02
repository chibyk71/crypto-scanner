// src/lib/strategy/buildSignal.ts

import type {
    PartialTPLevel,
    SignalLabel,
    TradeSignal,
} from '../../types';

import type { MarketRegime } from './regime/types';

/**
 * Helper to build the final TradeSignal object consistently
 * Ensures all fields are set correctly based on the new pure technical strategy.
 *
 * KEY CHANGES:
 *   • potentialSignal field is COMPLETELY REMOVED (no longer needed).
 *   • SL/TP/trailingStopDistance/positionSizeMultiplier are attached ONLY when signal !== 'hold'.
 *     This matches the new philosophy: base (unadjusted) levels are provided for valid signals,
 *     for use in simulation and as a starting point for AutoTradeService adjustments.
 *   • For 'hold' signals: all risk levels are undefined (no simulation or trade possible).
 *   • reasons array is preserved (technical explanations – very useful for final alert in AutoTradeService).
 *   • regime is attached as read-only instrumentation and must not affect signal generation.
 */
export function buildFinalSignal(params: {
    symbol: string;
    signal: 'buy' | 'sell' | 'hold';
    confidence: number;
    reasons: string[];
    features: number[];
    stopLoss?: number;
    takeProfit?: number;
    trailingStopDistance?: number;
    positionSizeMultiplier?: number;
    mlConfidence?: number;
    tplevels?: PartialTPLevel[];
    mlPredictedLabel?: SignalLabel;
    regime?: MarketRegime;
    /** Strategy engine that produced this signal. Default 'legacy' so legacy
     *  rows are attributable in simulated_trades without every call site
     *  having to pass engine explicitly. Regime engine overrides to 'regime'. */
    engine?: 'legacy' | 'regime';
}): TradeSignal {
    const {
        symbol,
        signal,
        confidence,
        reasons,
        features,
        stopLoss,
        takeProfit,
        trailingStopDistance,
        positionSizeMultiplier,
        mlConfidence,
        regime,
        engine = 'legacy',
    } = params;

    // Only attach risk levels if we have a valid buy/sell signal
    const hasValidSignal = signal !== 'hold';

    return {
        symbol,
        signal,
        confidence,
        regime,                       // Read-only instrumentation – must not affect scoring or trade eligibility
        reason: reasons,              // Array of technical reasons (will be shown in final alert)
        features,
        // Base (unadjusted) levels – AutoTradeService may modify them based on excursion regime
        stopLoss: hasValidSignal ? Number(stopLoss?.toFixed(8)) : undefined,
        takeProfit: hasValidSignal ? Number(takeProfit?.toFixed(8)) : undefined,
        trailingGivebackPrice: hasValidSignal ? trailingStopDistance : undefined,
        positionSizeMultiplier: hasValidSignal ? positionSizeMultiplier : undefined,
        mlConfidence,
        takeProfitLevels: hasValidSignal ? params.tplevels ?? [] : [],
        mlPredictedLabel: hasValidSignal ? params.mlPredictedLabel : undefined,
        engine,
    };
}
