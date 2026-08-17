// src/lib/strategy/types.ts
// =============================================================================
// STRATEGY TYPE DEFINITIONS
//
// This file contains the TypeScript interfaces that were previously defined
// inside src/lib/strategy.ts.
//
// IMPORTANT:
// These interfaces are moved mechanically from strategy.ts.
// Their structure and field definitions should remain unchanged so that the
// extracted strategy modules continue to use the exact same contracts.
// =============================================================================

import type { OhlcvData, SignalLabel } from '../../types';

/**
 * Complete input required for signal generation
 * Bundles market data and strategy parameters for clean API
 */
export interface StrategyInput {
    symbol: string;
    primaryData: OhlcvData;          // Fast timeframe (e.g., 3m) – primary signal source
    htfData: OhlcvData;              // Higher timeframe (e.g., 1h) – trend filter
    price: number;                   // Current market price
    atrMultiplier: number;           // Stop-loss distance in ATR multiples
    riskRewardTarget: number;        // Target R:R ratio
    trailingStopPercent: number;     // Legacy – kept for compatibility
    requireAtrFeasibility?: boolean;  // default true if omitted
}

/**
 * Internal summary of market regime (trend strength + volume behavior)
 * Used heavily in scoring and filtering
 *
 * This interface is shared by:
 *   • market/trendVolumeAnalysis.ts
 *   • scoring/computeScores.ts
 *   • signal determination logic
 *
 * It represents the result of the strategy's initial market analysis before
 * directional scores are calculated.
 */
export interface TrendAndVolume {
    hasVolumeSurge: boolean;         // Significant volume spike vs recent average
    vwmaFalling: boolean;            // Is VWMA trending down?
    trendBias: 'bullish' | 'bearish' | 'neutral';  // HTF directional bias
    isTrending: boolean;             // Strong trend confirmed by ADX + DI dominance
    engulfing: ("bullish" | "bearish" | null)[];   // Detected engulfing patterns
    liquiditySweep: ("bullish" | "bearish" | null)[]; // Detected liquidity sweeps
}

/**
 * Result of technical scoring + ML integration
 */
/**
 * Result of technical scoring + ML integration
 * Updated to include pre-excursion potential direction flag
 */
export interface ScoresAndML {
    buyScore: number;                // Total points for long direction
    sellScore: number;               // Total points for short direction
    features: number[];              // Feature vector for ML (same as training)
    mlConfidence: number;            // ML probability of profitable outcome (0-1)

    /**
     * NEW FIELD: Pre-excursion potential direction
     *   - Determined after all scoring (including ML bonus) but before any excursion-based adjustments/reversals.
     *   - 'long' if buyScore clearly dominates, 'short' if sellScore dominates, null otherwise.
     *   - Used in generateSignal() to set the 'potentialSignal' field ('buy'|'sell'|'hold') for triggering simulations
     *     even when the final signal is demoted to 'hold' due to excursion criteria (low samples, poor ratio/gap, etc.).
     *   - Helps ensure continuous simulation and history population for better future excursion decisions.
     */
    potentialDirection: 'long' | 'short' | null;

    // Optional: the raw label predicted by the ML model at signal generation
    // time. This is retained for later comparison with the actual trade outcome.
    mlPredictedLabel?: SignalLabel;

    /**
     * Optional instrumentation: pre-ML technical evidence broken down by
     * evidence category. Populated by computeScores; nothing downstream
     * currently reads this field. Used to prepare for future regime-based
     * weighting without changing current behaviour.
     */
    bucketBreakdown?: {
        trend: { buy: number; sell: number };
        momentum: { buy: number; sell: number };
        volume: { buy: number; sell: number };
        entry: { buy: number; sell: number };
    };
}
