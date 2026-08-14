// src/lib/strategy/constants.ts
// =============================================================================
// STRATEGY CONSTANTS
//
// This file contains every top-level strategy constant previously declared in:
//   src/lib/strategy.ts
//
// IMPORTANT:
// These constants are moved mechanically.
// Do not change their values, formulas, or relationships during this refactor.
//
// Modules such as computeScores.ts, determineSignal.ts, riskParams.ts, and
// trendVolumeAnalysis.ts will import only the constants they need from here.
// =============================================================================

import { config } from '../config/settings';

// ---------------------------------------------------------------
// SCORING CONSTANTS: Points system for signal strength (balanced for realism)
// ---------------------------------------------------------------

export const CONFIDENCE_THRESHOLD = config.strategy.confidenceThreshold;              // ← Minimum raw score to even consider a trade (lowered for more opportunities)

export const SCORE_MARGIN_REQUIRED = 50;             // ← Buy must beat Sell by at least this many points (dynamic in code)

export const EMA_ALIGNMENT_POINTS = 20;              // ← Price > EMA20 > HTF-EMA50 = strong alignment
export const VWMA_VWAP_POINTS = 15;                  // ← VWMA above VWAP = volume-weighted bullishness
export const MACD_POINTS = 15;                       // ← Full bullish MACD (crossover + positive histogram)
export const MACD_ZERO_POINTS = 5;                   // ← New: MACD line above/below zero for trend strength
export const RSI_POINTS = 10;                        // ← Classic overbought/oversold
export const STOCH_POINTS = 10;                      // ← Stochastic reversal in extreme zones
export const OBV_VWMA_POINTS = 10;                   // ← Volume confirming price direction
export const VWMA_SLOPE_POINTS = 5;                  // ← Direction of VWMA itself
export const ADX_POINTS = 10;                        // ← Confirms a trending market
export const ENGULFING_POINTS = 15;                  // ← Strong price-action candle
export const ML_BONUS_MAX = 20;                      // ← Max points added from ML probability
export const PERCENT_B_POINTS = 10;                  // BB position directional scoring
export const PERCENT_B_COMBO_POINTS = 5;             // bonus when percent_b + engulfing align
export const LIQUIDITY_SWEEP_POINTS = 15;            // ← Stop-hunt reversal: swept swing high/low then reclaimed
export const VWAP_REVERSION_POINTS = 15;             // ← Price stretched from VWAP without continuation confirmation
export const VWAP_DEVIATION_ATR_THRESHOLD = 1.75;    // ← |price-vwap|/ATR above this = "stretched" (tunable 1.5-2.0)
export const BB_SQUEEZE_BREAKOUT_POINTS = 15;        // ← Bandwidth expanded out of a squeeze with directional confirmation
export const ORDER_BOOK_IMBALANCE_POINTS = 12;       // ← Max points from order-book confirmation
export const DIRECTIONAL_TIEBREAK_MAX = 15;          // ← Max points from side-specific tie-breaker


// Total possible points per side (used later to normalise confidence)
//
// IMPORTANT:
// Keep this as the same explicit sum rather than replacing it with a literal
// number. Other logic conceptually depends on this representing the combined
// maximum scoring surface.
export const MAX_SCORE_PER_SIDE =
    EMA_ALIGNMENT_POINTS +
    VWMA_VWAP_POINTS +
    MACD_POINTS +
    MACD_ZERO_POINTS +
    RSI_POINTS +
    STOCH_POINTS +
    OBV_VWMA_POINTS +
    VWMA_SLOPE_POINTS +
    ADX_POINTS +
    ENGULFING_POINTS +
    PERCENT_B_POINTS +
    PERCENT_B_COMBO_POINTS +
    LIQUIDITY_SWEEP_POINTS +
    VWAP_REVERSION_POINTS +
    BB_SQUEEZE_BREAKOUT_POINTS +
    ORDER_BOOK_IMBALANCE_POINTS +
    DIRECTIONAL_TIEBREAK_MAX +
    ML_BONUS_MAX;


// ---------------------------------------------------------------
// MACHINE LEARNING SCORING CONSTANTS
// ---------------------------------------------------------------

export const ML_CONFIDENCE_DISCOUNT = 0.8;           // ← If model not trained, cut its vote by 20%

export const AMBIGUOUS_CONFIDENCE_MIN = 0.35;        // ← Combined ML confidence band treated as "uncertain"

export const AMBIGUOUS_CONFIDENCE_MAX = 0.65;


// ---------------------------------------------------------------
// RISK MANAGEMENT CONSTANTS
// ---------------------------------------------------------------

export const MIN_ATR_MULTIPLIER = 0.5;               // ← Safety bounds for stop-loss distance

export const MAX_ATR_MULTIPLIER = 5;

export const MIN_ATR_PCT = config.strategy.minAtrPct; // ← was hardcoded 0.35; empirically unreachable (BTC never exceeded 0.08% on 3m)

export const MAX_ATR_PCT = config.strategy.maxAtrPct;


// ---------------------------------------------------------------
// MARKET LIQUIDITY CONSTANTS
// ---------------------------------------------------------------

export const MIN_AVG_VOLUME_USD_PER_HOUR =
    config.strategy.minAvgVolumeUsdPerHour;          // ← Increased for better liquidity in crypto

export const BULL_MARKET_LIQUIDITY_MULTIPLIER = 0.75; // 25 % less strict in bull trends


// ---------------------------------------------------------------
// MARKET / INDICATOR FILTER CONSTANTS
// ---------------------------------------------------------------

export const MIN_BB_BANDWIDTH_PCT = 0.5;             // ← Minimum Bollinger Band width percentage to avoid flat markets

export const RELATIVE_VOLUME_MULTIPLIER = 1.5;       // ← Multiplier for relative volume check

export const MIN_DI_DIFF = 15;                       // ← Minimum difference between +DI and -DI for trend dominance

export const MIN_ADX = 20;                           // ← Minimum ADX for trend dominance

export const VOLUME_SURGE_MULTIPLIER = 2;            // ← Multiplier for volume surge


// ---------------------------------------------------------------
// PATTERN DETECTION CONSTANTS
// ---------------------------------------------------------------

export const LIQUIDITY_SWEEP_LOOKBACK = 20;          // ← Candles used to define the swing high/low range

export const BB_SQUEEZE_LOOKBACK = 10;               // ← Candles checked (excluding current) for prior squeeze condition

export const BB_SQUEEZE_MIN_SQUEEZE_RATIO = 0.7;     // ← Fraction of lookback candles that must be "squeezed" to qualify

export const BB_SQUEEZE_EXPANSION_RATIO = 1.15;      // ← Current bandwidth must be >= this x the squeeze-period average

export const MOMENTUM_IGNITION_LOOKBACK = 2;         // ← How many candles back to search for the trigger (engulfing+surge)

export const MOMENTUM_IGNITION_DECAY = [1.0, 0.5];   // ← Multiplier by offset: [0]=this candle, [1]=1 candle ago


// ---------------------------------------------------------------
// ORDER BOOK CONFIRMATION CONSTANTS
// ---------------------------------------------------------------

export const ORDER_BOOK_IMBALANCE_THRESHOLD = 0.15;  // ← Minimum |imbalance| to award any points

export const ORDER_BOOK_GATE_MARGIN = 15;            // ← Only fetch book when leading score is within this of CONFIDENCE_THRESHOLD
