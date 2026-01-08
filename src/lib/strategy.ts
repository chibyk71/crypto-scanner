// src/lib/strategy.ts
// =============================================================================
// STRATEGY ENGINE – HIGH-FREQUENCY SCALPING SIGNALS (3m primary + 1h HTF filter)
//
// Purpose:
//   • Generate precise buy/sell/hold signals using multi-timeframe confluence
//   • Point-based scoring system with clear, debuggable reasons
//   • Full integration of:
//       - Centralized indicators (via indicatorUtils)
//       - Excursion-based dynamic adjustments (MAE/MFE from symbolHistory)
//       - Machine Learning confidence bonus (5-tier model)
//       - Adaptive risk management (confidence + trend-aware sizing)
//   • Designed for crypto volatility: tight filters, volume confirmation, trend bias
//
// Key Design Principles:
//   • No black-box logic – every point addition has an explicit reason
//   • Early exits for low-liquidity or flat markets
//   • Counter-trend penalty (configurable)
//   • Realistic position sizing with leverage caps and confidence scaling
// =============================================================================

import type { OhlcvData, SignalLabel, TradeSignal } from '../types';
import { createLogger } from './logger';
import { MLService } from './services/mlService';
import { config } from './config/settings';
import { computeIndicators, type IndicatorMap } from './utils/indicatorUtils';
import { dbService } from './db';
import { getExcursionAdvice } from './utils/excursionUtils';
import { detectEngulfing } from './indicators';

// Dedicated logger – all strategy-related messages tagged 'Strategy'
const logger = createLogger('Strategy');

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
}

/**
 * Internal summary of market regime (trend strength + volume behavior)
 * Used heavily in scoring and filtering
 */
interface TrendAndVolume {
    hasVolumeSurge: boolean;         // Significant volume spike vs recent average
    vwmaFalling: boolean;            // Is VWMA trending down?
    trendBias: 'bullish' | 'bearish' | 'neutral';  // HTF directional bias
    isTrending: boolean;             // Strong trend confirmed by ADX + DI dominance
    engulfing: ("bullish" | "bearish" | null)[];   // Detected engulfing patterns
}

/**
 * Result of technical scoring + ML integration
 */
/**
 * Result of technical scoring + ML integration
 * Updated to include pre-excursion potential direction flag
 */
interface ScoresAndML {
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
}

// ---------------------------------------------------------------
// SCORING CONSTANTS: Points system for signal strength (balanced for realism)
// ---------------------------------------------------------------
const CONFIDENCE_THRESHOLD = config.strategy.confidenceThreshold;              // ← Minimum raw score to even consider a trade (lowered for more opportunities)
const SCORE_MARGIN_REQUIRED = 50;             // ← Buy must beat Sell by at least this many points (dynamic in code)

const EMA_ALIGNMENT_POINTS = 20;              // ← Price > EMA20 > HTF-EMA50 = strong alignment
const VWMA_VWAP_POINTS = 15;                  // ← VWMA above VWAP = volume-weighted bullishness
const MACD_POINTS = 15;                       // ← Full bullish MACD (crossover + positive histogram)
const MACD_ZERO_POINTS = 5;                   // ← New: MACD line above/below zero for trend strength
const RSI_POINTS = 10;                        // ← Classic overbought/oversold
const STOCH_POINTS = 10;                      // ← Stochastic reversal in extreme zones
const OBV_VWMA_POINTS = 10;                   // ← Volume confirming price direction
const ATR_POINTS = 10;                        // ← Volatility in a sane range (not too quiet, not crazy)
const VWMA_SLOPE_POINTS = 5;                  // ← Direction of VWMA itself
const ADX_POINTS = 10;                        // ← Confirms a trending market
const ENGULFING_POINTS = 15;                  // ← Strong price-action candle
const ML_BONUS_MAX = 20;                      // ← Max points added from ML probability


// Total possible points per side (used later to normalise confidence)
const MAX_SCORE_PER_SIDE =
    EMA_ALIGNMENT_POINTS +
    VWMA_VWAP_POINTS +
    MACD_POINTS +
    MACD_ZERO_POINTS +
    RSI_POINTS +
    STOCH_POINTS +
    OBV_VWMA_POINTS +
    ATR_POINTS +
    VWMA_SLOPE_POINTS +
    ADX_POINTS +
    ENGULFING_POINTS +
    ML_BONUS_MAX;

const ML_CONFIDENCE_DISCOUNT = 0.8;           // ← If model not trained, cut its vote by 20%

const MIN_ATR_MULTIPLIER = 0.5;               // ← Safety bounds for stop-loss distance
const MAX_ATR_MULTIPLIER = 5;

const DEFAULT_COOLDOWN_MINUTES = 10;          // ← Don't spam signals – wait at least 10 min

const MIN_AVG_VOLUME_USD_PER_HOUR = config.strategy.minAvgVolumeUsdPerHour;  // ← Increased for better liquidity in crypto
const BULL_MARKET_LIQUIDITY_MULTIPLIER = 0.75; // 25 % less strict in bull trends

const MIN_ATR_PCT = 0.1;                      // ← Realistic volatility range for crypto scalping
const MAX_ATR_PCT = 20;

const MIN_BB_BANDWIDTH_PCT = 0.3;             // ← Minimum Bollinger Band width percentage to avoid flat markets

const RELATIVE_VOLUME_MULTIPLIER = 1.5;       // ← Multiplier for relative volume check

const MIN_DI_DIFF = 4;                       // ← Minimum difference between +DI and -DI for trend dominance

const MIN_ADX = 18;                          // ← Minimum ADX for trend dominance
const VOLUME_SURGE_MULTIPLIER = 2;            // ← Multiplier for volume surge

const MIN_GAP = 0.20;                        // ← Minimum gap between MFE and |MAE| for bullishness

/**
 * Strategy – Core signal generation engine
 *
 * Responsibilities:
 *   • Multi-timeframe analysis
 *   • Point-based scoring with explicit reasons
 *   • Excursion-aware adjustments
 *   • ML integration
 *   • Adaptive risk management
 *   • Signal cooldown per symbol
 */
export class Strategy {
    // External dependencies
    private mlService: MLService;

    // Configuration
    private cooldownMinutes: number;

    // State
    private lastSignalTimes: Map<string, number> = new Map();  // Per-symbol cooldown tracking
    public lastAtr: number = 0;                               // Latest ATR (exposed for debugging)

    /**
     * Constructor
     * @param mlService - Machine learning service for prediction bonus
     * @param cooldownMinutes - Minimum minutes between signals per symbol
     */
    constructor(mlService: MLService, cooldownMinutes: number = DEFAULT_COOLDOWN_MINUTES) {
        this.mlService = mlService;
        this.cooldownMinutes = cooldownMinutes;
    }

    // =========================================================================
    // TREND + VOLUME ANALYSIS: Market regime detection with liquidity filter
    // =========================================================================
    /**
     * Analyzes higher-timeframe trend strength, volume behavior, and liquidity.
     *
     * Called from:
     *   • generateSignal() – early in the pipeline
     *
     * Responsibilities:
     *   • Determine HTF trend bias (bullish/bearish/neutral) using ADX + DI
     *   • Calculate average hourly volume in USD for liquidity filtering
     *   • Detect volume surges (both USD and base volume)
     *   • Identify VWMA slope direction
     *   • Detect engulfing patterns (cheap operation)
     *   • Early exit with neutral result if liquidity too low
     *
     * Why liquidity check here?
     *   • Prevents processing illiquid symbols (slippage, fake moves)
     *   • Dynamic threshold: relaxed in strong bull trends (ADX > 35)
     *
     * @param primaryData - Fast timeframe OHLCV (for volume calculations)
     * @param indicators - Pre-computed indicators (for HTF ADX/DI)
     * @param _price - Current price (unused but kept for future extensions)
     * @returns TrendAndVolume summary used throughout scoring
     * @private
     */
    private _analyzeTrendAndVolume(primaryData: OhlcvData, indicators: IndicatorMap, _price: number): TrendAndVolume {
        // ------------------------------------------------------------------
        // 1. HTF TREND INITIALIZATION & LIQUIDITY CHECK
        // ------------------------------------------------------------------
        const LOOKBACK = 50;
        const volSlice = primaryData.volumes.slice(-LOOKBACK);
        const priceSlice = primaryData.closes.slice(-LOOKBACK);

        // Safety check for insufficient data
        const len = Math.min(volSlice.length, priceSlice.length);
        if (len === 0) {
            logger.warn(`No data for ${primaryData.symbol} – skipping`);
            return this._neutral();
        }

        // Calculate average volume in USD over last 50 candles
        const avgBaseVol = volSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;
        const avgPrice = priceSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;
        const avgVolumeUSD = avgBaseVol * avgPrice;

        // Determine HTF trend bias using ADX and Directional Indicators
        const { htfAdx: adx, htfPdi: pdi, htfMdi: mdi } = indicators.last;
        const diDiff = Math.abs(pdi - mdi);

        // Debug log – helpful for tuning ADX thresholds
        console.log(`ADX Analysis for ${primaryData.symbol}: ADX=${adx.toFixed(2)}, +DI=${pdi.toFixed(2)}, -DI=${mdi.toFixed(2)}, DI Diff=${diDiff.toFixed(2)}`);

        const isTrending = adx > MIN_ADX && diDiff > MIN_DI_DIFF;
        const trendBias = isTrending
            ? pdi > mdi ? 'bullish' : 'bearish'
            : 'neutral';

        // Dynamic liquidity threshold: more lenient in strong bull trends
        const baseThreshold = MIN_AVG_VOLUME_USD_PER_HOUR;
        const bullMultiplier = trendBias === 'bullish' && adx > 35 ? BULL_MARKET_LIQUIDITY_MULTIPLIER : 1.0;
        const threshold = baseThreshold * bullMultiplier;
        const hasLiquidity = avgVolumeUSD >= threshold;

        // ------------------------------------------------------------------
        // 2. ENGULFING PATTERN DETECTION (always run – low cost)
        // ------------------------------------------------------------------
        const engulfing = detectEngulfing(
            primaryData.opens,
            primaryData.highs,
            primaryData.lows,
            primaryData.closes
        );

        // EARLY EXIT: Reject low-liquidity symbols entirely
        if (!hasLiquidity) {
            logger.info(
                `Low liquidity ${primaryData.symbol}: ` +
                `$${avgVolumeUSD.toFixed(0)}/hr < $${threshold.toFixed(0)} ` +
                `(trend=${trendBias})`
            );
            return this._neutral();
        }

        // ------------------------------------------------------------------
        // 3. VOLUME SURGE DETECTION – Dual confirmation (USD + base volume)
        // ------------------------------------------------------------------
        const lookback = 20; // Use obvLookback for short-term volume average
        const recentVols = primaryData.volumes.slice(-lookback - 1, -1);
        const recentPrices = primaryData.closes.slice(-lookback - 1, -1);

        // Average volume in USD over previous 20 candles
        const avgPrevUSD = recentVols.reduce((sum, v, i) => sum + v * recentPrices[i], 0) / lookback;

        // Current candle volume in USD
        const currentVolUSD = primaryData.volumes[primaryData.volumes.length - 1] * primaryData.closes[primaryData.closes.length - 1];

        // Primary surge check (USD value)
        let hasVolumeSurge = currentVolUSD > avgPrevUSD * VOLUME_SURGE_MULTIPLIER;

        // Secondary check: raw base volume surge (prevents price-driven false positives)
        const volLookback = 20;
        const recentBaseVols = primaryData.volumes.slice(-volLookback - 1, -1);
        const avgBaseVol20 = recentBaseVols.reduce((sum, v) => sum + v, 0) / volLookback;
        const currentBaseVol = primaryData.volumes[primaryData.volumes.length - 1];
        const hasRelativeVolumeSurge = currentBaseVol > avgBaseVol20 * RELATIVE_VOLUME_MULTIPLIER;

        // Require both for strong confirmation
        hasVolumeSurge = hasVolumeSurge && hasRelativeVolumeSurge;

        // ------------------------------------------------------------------
        // 4. VWMA SLOPE DIRECTION
        // ------------------------------------------------------------------
        const vwmaSlope = indicators.last.vwma - (indicators.vwma[indicators.vwma.length - 2] ?? indicators.last.vwma);
        const vwmaFalling = vwmaSlope < 0;

        // ------------------------------------------------------------------
        // 5. RETURN COMPREHENSIVE REGIME SUMMARY
        // ------------------------------------------------------------------
        return {
            hasVolumeSurge,
            vwmaFalling,
            trendBias,
            isTrending,
            engulfing,
        };
    }

    // =========================================================================
    // HELPER: Neutral regime state (DRY early exit)
    // =========================================================================
    /**
     * Returns a neutral TrendAndVolume object.
     *
     * Used for:
     *   • Early exits (insufficient data, low liquidity)
     *   • Prevents downstream null checks
     *
     * @private
     */
    private _neutral(): TrendAndVolume {
        return {
            hasVolumeSurge: false,
            vwmaFalling: false,
            trendBias: 'neutral',
            isTrending: false,
            engulfing: [null],
        };
    }

    // =========================================================================
    // POINT-BASED SCORING: Calculate buy/sell strength with explicit reasons
    // =========================================================================
    /**
     * Core scoring engine – assigns points to buy and sell sides based on technical conditions.
     *
     * Called from:
     *   • generateSignal() – after trend/volume analysis
     *
     * Design:
     *   • Tiered scoring for nuanced conditions (e.g., full vs partial MACD)
     *   • Every point addition includes a clear reason string
     *   • Integrates ML prediction as final bonus
     *   • Safe numeric handling for potentially undefined indicator values
     *
     * @param indicators - Centralized indicator results
     * @param trendAndVolume - Market regime from _analyzeTrendAndVolume
     * @param input - Strategy parameters and price
     * @param reasons - Mutable array filled with human-readable explanations
     * @returns Scores, ML features, and confidence for final decision
     * @private
     */
    private async _computeScores(indicators: IndicatorMap, trendAndVolume: TrendAndVolume, input: StrategyInput, reasons: string[]): Promise<ScoresAndML> {
        let buyScore = 0;
        let sellScore = 0;

        // -------------------- EMA ALIGNMENT --------------------
        if (input.price > indicators.last.emaShort && indicators.last.emaShort > indicators.last.htfEmaMid) {
            buyScore += EMA_ALIGNMENT_POINTS;
            reasons.push('Bullish EMA alignment: Price > EMA20 > HTF EMA50');
        } else if (input.price < indicators.last.emaShort && indicators.last.emaShort < indicators.last.htfEmaMid) {
            sellScore += EMA_ALIGNMENT_POINTS;
            reasons.push('Bearish EMA alignment: Price < EMA20 < HTF EMA50');
        }

        // -------------------- VWMA vs VWAP --------------------
        if (indicators.last.vwma > indicators.last.vwap) {
            buyScore += VWMA_VWAP_POINTS;
            reasons.push('Bullish VWMA > VWAP');
        } else if (indicators.last.vwma < indicators.last.vwap) {
            sellScore += VWMA_VWAP_POINTS;
            reasons.push('Bearish VWMA < VWAP');
        }

        // -------------------- MACD (tiered scoring) --------------------
        // Safe conversion – some indicator libs may return undefined
        const macdVal = Number(indicators.last.macdLine ?? 0);
        const macdSignalVal = Number(indicators.last.macdSignal ?? 0);
        const macdHistVal = Number(indicators.last.macdHistogram ?? 0);

        if (macdVal && macdHistVal && macdSignalVal) {
            const macdCrossUp = macdVal > macdSignalVal;
            const histPositive = macdHistVal > 0;

            if (macdCrossUp && histPositive) {
                buyScore += MACD_POINTS;
                reasons.push('Strong Bullish MACD: Crossover + Positive Histogram');
            } else if (macdCrossUp) {
                buyScore += MACD_POINTS / 2;
                reasons.push('Weak Bullish MACD: Crossover but Histogram not positive');
            }

            const macdCrossDown = macdVal < macdSignalVal;
            const histNegative = macdHistVal < 0;

            if (macdCrossDown && histNegative) {
                sellScore += MACD_POINTS;
                reasons.push('Strong Bearish MACD: Crossover + Negative Histogram');
            } else if (macdCrossDown) {
                sellScore += MACD_POINTS / 2;
                reasons.push('Weak Bearish MACD: Crossover but Histogram not negative');
            }

            // MACD zero-line confirmation
            if (macdVal > 0) {
                buyScore += MACD_ZERO_POINTS;
                reasons.push('Bullish MACD above zero line');
            } else if (macdVal < 0) {
                sellScore += MACD_ZERO_POINTS;
                reasons.push('Bearish MACD below zero line');
            }
        }

        // -------------------- RSI --------------------
        if (indicators.last.rsi < 30) {
            buyScore += RSI_POINTS;
            reasons.push('Oversold RSI <30');
        } else if (indicators.last.rsi > 70) {
            sellScore += RSI_POINTS;
            reasons.push('Overbought RSI >70');
        }

        // -------------------- STOCHASTIC --------------------
        if (indicators.last.stochasticK < 20 && indicators.last.stochasticK > indicators.last.stochasticD) {
            buyScore += STOCH_POINTS;
            reasons.push('Bullish Stochastic crossover in oversold');
        } else if (indicators.last.stochasticK > 80 && indicators.last.stochasticK < indicators.last.stochasticD) {
            sellScore += STOCH_POINTS;
            reasons.push('Bearish Stochastic crossover in overbought');
        }

        // -------------------- OBV + VWMA MOMENTUM --------------------
        const obvRising = indicators.last.obv > (indicators.obv[indicators.obv.length - 2] ?? indicators.last.obv);
        if (obvRising && input.price > indicators.last.vwma) {
            buyScore += OBV_VWMA_POINTS;
            reasons.push('Bullish OBV rising with price above VWMA (momentum)');
        } else if (!obvRising && input.price < indicators.last.vwma) {
            sellScore += OBV_VWMA_POINTS;
            reasons.push('Bearish OBV falling with price below VWMA (momentum)');
        }

        // -------------------- ATR VOLATILITY RANGE --------------------
        const atrPct = (indicators.last.atr / input.price) * 100;
        if (atrPct > MIN_ATR_PCT && atrPct < MAX_ATR_PCT) {
            buyScore += ATR_POINTS;
            sellScore += ATR_POINTS;
            reasons.unshift(`Sane ATR volatility: ${atrPct.toFixed(2)}%`);
        }

        // -------------------- VWMA SLOPE --------------------
        if (!trendAndVolume.vwmaFalling) {
            buyScore += VWMA_SLOPE_POINTS;
            reasons.push('Bullish VWMA slope');
        } else {
            sellScore += VWMA_SLOPE_POINTS;
            reasons.push('Bearish VWMA slope');
        }

        // -------------------- ADX TREND STRENGTH --------------------
        if (trendAndVolume.isTrending) {
            if (trendAndVolume.trendBias === 'bullish') {
                buyScore += ADX_POINTS;
            } else if (trendAndVolume.trendBias === 'bearish') {
                sellScore += ADX_POINTS;
            }
            reasons.unshift(`Strong trend confirmed by ADX >${MIN_ADX}`);
        }

        // -------------------- ENGULFING PATTERN --------------------
        const lastPattern = trendAndVolume.engulfing[trendAndVolume.engulfing.length - 1];
        if (lastPattern === 'bullish' && trendAndVolume.hasVolumeSurge) {
            buyScore += ENGULFING_POINTS;
            reasons.push('Bullish Engulfing candle confirmed with volume surge');
        } else if (lastPattern === 'bearish' && trendAndVolume.hasVolumeSurge) {
            sellScore += ENGULFING_POINTS;
            reasons.push('Bearish Engulfing candle confirmed with volume surge');
        }

        // -------------------- ML PREDICTION INTEGRATION --------------------
        const features = await this.mlService.extractFeatures(input);

        let mlWinConfidence = 0;
        let mlLossConfidence = 0;
        let predictedLabel: SignalLabel = 0;

        if (this.mlService.isReady()) {
            const prediction = this.mlService.predict(features);

            predictedLabel = prediction.label;
            mlWinConfidence = prediction.confidence;
            mlLossConfidence = 1 - mlWinConfidence;

            if (predictedLabel >= 1) {
                const bonus = mlWinConfidence * ML_BONUS_MAX;
                buyScore += bonus;
                reasons.unshift(`ML PREDICTS WIN (label ${predictedLabel}) → +${bonus.toFixed(0)}pts (${(mlWinConfidence * 100).toFixed(1)}%)`);
            } else if (predictedLabel <= -1) {
                const bonus = mlLossConfidence * ML_BONUS_MAX * 0.9;
                sellScore += bonus;
                reasons.unshift(`ML PREDICTS LOSS (label ${predictedLabel}) → +${bonus.toFixed(0)}pts (${(mlLossConfidence * 100).toFixed(1)}%)`);
            } else {
                reasons.push(`ML neutral (label 0) → no bonus`);
            }

            logger.debug('ML Prediction Applied', {
                symbol: input.symbol,
                predictedLabel,
                winConf: (mlWinConfidence * 100).toFixed(1) + '%',
                lossConf: (mlLossConfidence * 100).toFixed(1) + '%',
                buyScore: buyScore.toFixed(1),
                sellScore: sellScore.toFixed(1),
            });
        } else {
            reasons.push('ML model not ready → no prediction bonus');
            buyScore *= ML_CONFIDENCE_DISCOUNT;
            sellScore *= ML_CONFIDENCE_DISCOUNT;
        }

        // ──────────────────────────────────────────────────────────────
        // NEW CHANGE: Identify pre-excursion potential direction
        //   - Based on raw buyScore vs sellScore (after all technical + ML bonuses).
        //   - 'long' if buyScore significantly > sellScore, 'short' if vice versa.
        //   - Used in generateSignal to set 'potentialSignal' ('buy'|'sell') for simulation triggering.
        //   - If scores are close or both low, return null (no potential) – translates to 'hold'.
        //   - This helps flag viable signals before excursion may skip/reverse them.
        // ──────────────────────────────────────────────────────────────
        let potentialDirection: 'long' | 'short' | null = null;
        const scoreMargin = SCORE_MARGIN_REQUIRED * 0.5;  // Relaxed margin for potential (pre-excursion)
        if (buyScore >= CONFIDENCE_THRESHOLD && buyScore - sellScore >= scoreMargin) {
            potentialDirection = 'long';
        } else if (sellScore >= CONFIDENCE_THRESHOLD && sellScore - buyScore >= scoreMargin) {
            potentialDirection = 'short';
        }

        if (potentialDirection) {
            reasons.push(`Pre-excursion potential direction: ${potentialDirection} (buy=${buyScore.toFixed(1)}, sell=${sellScore.toFixed(1)})`);
        } else {
            reasons.push('No clear pre-excursion potential direction');
        }

        return { buyScore, sellScore, features, mlConfidence: mlWinConfidence, potentialDirection };
    }

    // =========================================================================
    // FINAL SIGNAL DECISION: Apply filters and determine direction/confidence
    // =========================================================================
    /**
     * Converts raw scores into final signal with confidence level.
     *
     * Called from:
     *   • generateSignal() – after scoring complete
     *
     * Logic:
     *   • Early reject on poor risk conditions
     *   • Dynamic score margin requirement
     *   • Confidence normalized to 0-100%
     *   • Clear reasons for hold decisions
     *
     * @param buyScore - Total long points
     * @param sellScore - Total short points
     * @param trendBias - HTF directional bias
     * @param isRiskEligible - ATR volatility sanity check
     * @param reasons - Mutable array for explanations
     * @returns Final signal and confidence
     * @private
     */
    private _determineSignal(
        buyScore: number,
        sellScore: number,
        trendBias: TrendAndVolume['trendBias'],
        isRiskEligible: boolean,
        reasons: string[]
    ): { signal: TradeSignal['signal']; confidence: number } {
        // Early exit if volatility out of bounds
        if (!isRiskEligible) {
            reasons.push('Risk ineligible: ATR out of bounds');
            return { signal: 'hold', confidence: 0 };
        }

        // Counter-trend penalty note (currently disabled but logged)
        if (buyScore > sellScore && trendBias !== 'bullish' && trendBias !== 'neutral') {
            buyScore *= 0.8;
            reasons.push('Counter-trend buy: 20% score penalty applied');
        } else if (sellScore > buyScore && trendBias !== 'bearish' && trendBias !== 'neutral') {
            sellScore *= 0.8;
            reasons.push('Counter-trend sell: 20% score penalty applied');
        }

        // Dynamic margin – stricter when scores are low
        const dynamicMargin = Math.min(SCORE_MARGIN_REQUIRED, CONFIDENCE_THRESHOLD * 0.29);

        let signal: TradeSignal['signal'] = 'hold';
        let confidence = 0;

        if (buyScore >= CONFIDENCE_THRESHOLD && buyScore - sellScore >= dynamicMargin) {
            signal = 'buy';
            confidence = (buyScore / MAX_SCORE_PER_SIDE) * 100;
        } else if (sellScore >= CONFIDENCE_THRESHOLD && sellScore - buyScore >= dynamicMargin) {
            signal = 'sell';
            confidence = (sellScore / MAX_SCORE_PER_SIDE) * 100;
        } else {
            reasons.push('No clear signal: Insufficient score margin or trend mismatch');
        }

        confidence = Math.min(confidence, 100);

        return { signal, confidence };
    }

    // =========================================================================
    // RISK ELIGIBILITY: Basic volatility sanity check
    // =========================================================================
    /**
     * Quick filter to reject symbols with unrealistic ATR volatility.
     *
     * Called from:
     *   • _determineSignal() – before final signal decision
     *
     * Purpose:
     *   • Avoid trades in dead-flat or hyper-volatile markets
     *   • Tighter bounds than general strategies (optimized for crypto scalping)
     *
     * @param price - Current market price
     * @param lastAtr - Latest ATR value
     * @returns true if volatility is in acceptable range
     * @private
     */
    private _isRiskEligible(price: number, lastAtr: number): boolean {
        const atrPct = (lastAtr / price) * 100;
        return atrPct > MIN_ATR_PCT && atrPct < MAX_ATR_PCT;
    }

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
     * @private
     */
    private _computeRiskParams(
        signal: TradeSignal['signal'],
        price: number,
        atrMultiplier: number,
        riskRewardTarget: number,
        confidence: number,
        lastAtr: number,
        trendBias: TrendAndVolume['trendBias'],
        accountBalance: number | undefined = 1000
    ): {
        stopLoss?: number;
        takeProfit?: number;
        trailingStopDistance?: number;
        positionSizeUsd: number;
        positionSizeMultiplier?: number;
        riskAmountUsd: number;
    } {
        // No signal → zero risk
        if (signal === 'hold') {
            return {
                stopLoss: undefined,
                takeProfit: undefined,
                trailingStopDistance: undefined,
                positionSizeUsd: 0,
                positionSizeMultiplier: 0,
                riskAmountUsd: 0,
            };
        }

        // ──────────────────────────────────────────────────────────────
        // 1. Base risk % per trade – survival first
        // ──────────────────────────────────────────────────────────────
        const BASE_RISK_PERCENT_BULL = 0.005;    // 0.50% in bull/neutral
        const BASE_RISK_PERCENT_BEAR = 0.0025;  // 0.25% in bear (volatility hurts)
        const MAX_RISK_BONUS_CONFIDENCE = 0.005; // +0.50% at max confidence

        const baseRiskPercent = trendBias === 'bearish' ? BASE_RISK_PERCENT_BEAR : BASE_RISK_PERCENT_BULL;

        // Confidence bonus: scales risk upward for high-confidence setups
        const confidenceFactor = Math.min((confidence - 70) / 30, 1); // 0-1 range
        const bonusRiskPercent = confidenceFactor * MAX_RISK_BONUS_CONFIDENCE;

        const finalRiskPercent = baseRiskPercent + bonusRiskPercent;
        const riskAmountUsd = accountBalance * finalRiskPercent;

        // ──────────────────────────────────────────────────────────────
        // 2. Stop-loss distance (ATR-based with bounds)
        // ──────────────────────────────────────────────────────────────
        const clampedMultiplier = Math.min(Math.max(atrMultiplier, MIN_ATR_MULTIPLIER), MAX_ATR_MULTIPLIER);
        const riskDistance = lastAtr * clampedMultiplier;

        // Safety: reject absurd stops (>10% move)
        if (riskDistance <= 0 || riskDistance / price > 0.10) {
            logger.info(`Unrealistic risk distance calculated: ${riskDistance.toFixed(4)} (skipping trade)`);
            return {
                stopLoss: undefined,
                takeProfit: undefined,
                trailingStopDistance: undefined,
                positionSizeUsd: 0,
                positionSizeMultiplier: 0,
                riskAmountUsd: 0,
            };
        }

        // ──────────────────────────────────────────────────────────────
        // 3. Position size in USD (risk-based)
        // ──────────────────────────────────────────────────────────────
        const rawPositionSizeUsd = riskAmountUsd / (riskDistance / price);

        // Hard leverage cap – never exceed 5× notional
        const maxAllowedNotional = accountBalance * 5.0;
        const positionSizeUsd = Math.min(rawPositionSizeUsd, maxAllowedNotional);

        // ──────────────────────────────────────────────────────────────
        // 4. Stop Loss & Take Profit levels
        // ──────────────────────────────────────────────────────────────
        const stopLoss = signal === 'buy' ? price - riskDistance : price + riskDistance;
        const takeProfit = signal === 'buy' ? price + riskDistance * riskRewardTarget : price - riskDistance * riskRewardTarget;

        // ──────────────────────────────────────────────────────────────
        // 5. Trailing stop – 75% of initial risk (aggressive for scalping)
        // ──────────────────────────────────────────────────────────────
        const trailingStopDistance = riskDistance * 0.75;

        // ──────────────────────────────────────────────────────────────
        // 6. Legacy multiplier (for systems still using it)
        // ──────────────────────────────────────────────────────────────
        const positionSizeMultiplier = Math.min(positionSizeUsd / accountBalance * 5, 1.5);

        // ──────────────────────────────────────────────────────────────
        // Final structured return
        // ──────────────────────────────────────────────────────────────
        return {
            stopLoss: Number(stopLoss.toFixed(8)),
            takeProfit: Number(takeProfit.toFixed(8)),
            trailingStopDistance: Number(trailingStopDistance.toFixed(8)),
            positionSizeUsd: Number(positionSizeUsd.toFixed(2)),
            positionSizeMultiplier: Number(positionSizeMultiplier.toFixed(3)),
            riskAmountUsd: Number(riskAmountUsd.toFixed(2)),
        };
    }

    // =========================================================================
    // PUBLIC API: Main signal generation entry point
    // =========================================================================
    /**
     * Primary method – generates a complete TradeSignal for a symbol.
     *
     * Called from:
     *   • MarketScanner.processSymbol() – for every symbol on each scan
     *
     * Full Pipeline:
     *   1. Cooldown check per symbol
     *   2. Centralized indicator calculation
     *   3. Trend/volume analysis (liquidity + trend filter)
     *   4. Flat market check (Bollinger Bandwidth)
     *   5. Point scoring + ML prediction
     *   6. Enriched excursion history fetch + regime-aware advice
     *   7. Dynamic regime adjustments (recent reversals, MFE/MAE)
     *   8. Final signal decision
     *   9. Risk parameter calculation with dynamic SL/TP multipliers
     *   10. Update cooldown and return rich TradeSignal
     *
     * Early exits:
     *   • Cooldown active
     *   • No trending market
     *   • Flat Bollinger Bands
     *   • Excessive drawdown risk (high MAE)
     *
     * @param input - Full market context and parameters
     * @returns Complete TradeSignal with reasons, risk params, ML data
     */
    public async generateSignal(input: StrategyInput): Promise<TradeSignal> {
        const reasons: string[] = [];
        const { symbol, primaryData, htfData, price, atrMultiplier, riskRewardTarget } = input;

        // Per-symbol cooldown
        const now = Date.now();
        const last = this.lastSignalTimes.get(symbol) ?? 0;
        if ((now - last) / (1000 * 60) < this.cooldownMinutes) {
            reasons.push(`Cooldown active (<${this.cooldownMinutes} min since last signal)`);
            return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [], potentialSignal: 'hold' };
        }

        try {
            // === 1. Centralized indicators ===
            const indicators = computeIndicators(primaryData, htfData);
            this.lastAtr = indicators.last.atr;

            // === 2. Trend + volume analysis ===
            const trendAndVolume = this._analyzeTrendAndVolume(primaryData, indicators, price);
            if (!trendAndVolume.isTrending) {
                reasons.push('No trending market – holding');
                return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [], potentialSignal: 'hold' };
            }

            // === 3. Flat market filter ===
            if (indicators.last.bbBandwidth < MIN_BB_BANDWIDTH_PCT) {
                reasons.push(`Flat market: BB Bandwidth ${indicators.last.bbBandwidth.toFixed(2)}%`);
                return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [], potentialSignal: 'hold' };
            }

            // === 4. Scoring + ML ===
            const scoringResult = await this._computeScores(indicators, trendAndVolume, input, reasons);
            let buyScore = scoringResult.buyScore;
            let sellScore = scoringResult.sellScore;
            const features = scoringResult.features;
            const mlConfidence = scoringResult.mlConfidence;

            // ──────────────────────────────────────────────────────────────
            // NEW CHANGE: Determine pre-excursion 'potentialSignal'
            //   - After raw scoring + ML (before any excursion adjustments), evaluate if there's a viable
            //     potential signal based on scores meeting thresholds and margin.
            //   - This uses the same logic as _determineSignal but without excursion boosts or reversals.
            //   - potentialSignal is always returned in the TradeSignal object for the scanner to use
            //     in triggering simulations (even if final signal is 'hold' due to excursion skip/reverse failure).
            //   - If no potential (scores too low), set 'hold' – no simulation needed.
            //   - This enables simulations to run on "would-be" signals before excursion filtering,
            //     populating history for better future excursion decisions.
            // ──────────────────────────────────────────────────────────────
            let potentialSignal: 'buy' | 'sell' | 'hold' = 'hold';
            const preExcursion = this._determineSignal(
                buyScore,
                sellScore,
                trendAndVolume.trendBias,
                this._isRiskEligible(price, indicators.last.atr),
                []  // No extra reasons for potential
            );
            if (preExcursion.signal !== 'hold') {
                potentialSignal = preExcursion.signal;
                reasons.push(`Pre-excursion potential signal detected: ${potentialSignal} (raw scores: buy=${buyScore.toFixed(1)}, sell=${sellScore.toFixed(1)})`);
            } else {
                reasons.push('No pre-excursion potential signal – scores below thresholds');
            }

            // === 5. Real-time regime (live + recent closed) ===
            const regime = await dbService.getCurrentRegime(symbol);

            let tpMultiplier = 1.0;
            let slMultiplier = 1.0;
            let confidenceBoost = 0;
            let excursionAdvice = 'ℹ️ No excursion data yet';
            let isReversed = false;

            const intendedDirection: 'long' | 'short' = buyScore > sellScore ? 'long' : 'short';

            // Single call to centralized excursion logic
            if (regime.sampleCount > 0) {
                const adviceObj = getExcursionAdvice(regime as any, intendedDirection);

                excursionAdvice = adviceObj.advice;
                reasons.push(excursionAdvice);

                tpMultiplier *= adviceObj.adjustments.tpMultiplier;
                slMultiplier *= adviceObj.adjustments.slMultiplier;
                confidenceBoost += adviceObj.adjustments.confidenceBoost;

                if (adviceObj.action === 'skip') {
                    reasons.push('Signal skipped due to excursion analysis');
                    // Final signal demoted to 'hold' (no alert/trade), but potentialSignal preserved for simulation
                    return { symbol, signal: 'hold', confidence: 0, reason: reasons, features, potentialSignal };
                }

                if (adviceObj.action === 'reverse') {
                    isReversed = true;
                    reasons.push('Signal reversed due to excursion analysis');

                    // ──────────────────────────────────────────────────────────────
                    // NEW CHANGE: Enhanced reversal adjustment and re-validation
                    //   - For reversals, halve the original score and double the reversed score
                    //     to aggressively favor the flip (as per suggestion: find best way for results).
                    //   - Identify original/reversed based on pre-swap dominance.
                    //   - After adjustment, re-validate: new reversed score must meet threshold
                    //     and excursion gap >= minGap (using regime's MFE - |MAE|).
                    //   - If re-validation fails, demote final signal to 'hold' but simulate the
                    //     attempted reversed (update potentialSignal to reversed for sim).
                    //   - This ensures we only alert on strong reversals but always simulate to build history.
                    // ──────────────────────────────────────────────────────────────
                    const originalWasBuy = buyScore > sellScore;
                    if (originalWasBuy) {
                        buyScore /= 2;  // Halve original
                        sellScore *= 2; // Double reversed
                    } else {
                        sellScore /= 2; // Halve original
                        buyScore *= 2; // Double reversed
                    }
                    reasons.push(`Reversal scores adjusted: original halved, reversed doubled (buy=${buyScore.toFixed(1)}, sell=${sellScore.toFixed(1)})`);

                    // Re-validate post-adjustment
                    const gap = regime.mfe - Math.abs(regime.mae);  // From regime (excursion metrics)
                    const postAdjust = this._determineSignal(
                        buyScore,
                        sellScore,
                        trendAndVolume.trendBias,
                        this._isRiskEligible(price, indicators.last.atr),
                        reasons
                    );
                    if (postAdjust.signal === 'hold' || gap < MIN_GAP) {
                        reasons.push(`Post-reversal validation failed (score/gap too low) – demoting to hold`);
                        // Simulate the attempted reversed anyway
                        potentialSignal = originalWasBuy ? 'sell' : 'buy';
                        return { symbol, signal: 'hold', confidence: 0, reason: reasons, features, potentialSignal };
                    } else {
                        // Successful reversal – update potential to reflect reversed for sim consistency
                        potentialSignal = postAdjust.signal;
                    }
                }
            } else {
                reasons.push(excursionAdvice);
                // On no data: cautious allow (bootstrap new symbols)
                confidenceBoost -= 0.05;
            }

            // Apply excursion + ML boost (after potential reverse swap)
            buyScore += confidenceBoost * 20;
            sellScore += confidenceBoost * 20;

            // === 6. Final signal decision (respects reverse via swapped scores) ===
            const { signal: finalSignal, confidence } = this._determineSignal(
                buyScore,
                sellScore,
                trendAndVolume.trendBias,
                this._isRiskEligible(price, indicators.last.atr),
                reasons
            );

            let signal = finalSignal;

            // === 7. Dynamic risk params ===
            const riskParams = this._computeRiskParams(
                signal,
                price,
                atrMultiplier,
                riskRewardTarget,
                confidence,
                indicators.last.atr,
                trendAndVolume.trendBias,
            );

            let stopLoss = riskParams.stopLoss;
            let takeProfit = riskParams.takeProfit;
            let positionSizeMultiplier = riskParams.positionSizeMultiplier;

            if (signal !== 'hold') {
                const baseSlDistance = Math.abs(price - (stopLoss ?? price));
                const baseTpDistance = Math.abs((takeProfit ?? price) - price);

                // Apply excursion multipliers
                stopLoss = signal === 'buy'
                    ? price - baseSlDistance * slMultiplier
                    : price + baseSlDistance * slMultiplier;

                takeProfit = signal === 'buy'
                    ? price + baseTpDistance * tpMultiplier
                    : price - baseTpDistance * tpMultiplier;

                // Reversal-specific: reduce size (no manual SL/TP mirroring needed — direction flipped via score swap)
                if (isReversed) {
                    positionSizeMultiplier = (positionSizeMultiplier ?? 1.0) * 0.7;
                    reasons.push('Position size reduced for reversal trade (x0.7)');
                }
            }

            // Summary reasons for TP/SL adjustments
            if (tpMultiplier < 0.95) reasons.push(`Take-profit reduced (x${tpMultiplier.toFixed(2)})`);
            if (tpMultiplier > 1.05) reasons.push(`Take-profit expanded (x${tpMultiplier.toFixed(2)})`);
            if (slMultiplier < 0.95) reasons.push(`Stop-loss tightened (x${slMultiplier.toFixed(2)})`);
            if (slMultiplier > 1.05) reasons.push(`Stop-loss loosened (x${slMultiplier.toFixed(2)})`);

            // Update cooldown only on actual signals
            if (signal !== 'hold') {
                this.lastSignalTimes.set(symbol, now);
            }

            // Debug log (single advice call)
            logger.info(`Signal: ${signal.toUpperCase()} ${symbol} @ ${price.toFixed(8)}`, {
                confidence: confidence.toFixed(2),
                buyScore: buyScore.toFixed(1),
                sellScore: sellScore.toFixed(1),
                liveSamples: regime.sampleCount,
                activeSims: regime.activeCount ?? 0,
                excursionRatio: regime.excursionRatio?.toFixed(2) ?? 'N/A',
                TPx: tpMultiplier.toFixed(2),
                SLx: slMultiplier.toFixed(2),
                excursionAction: regime.sampleCount > 0 ? getExcursionAdvice(regime as any, intendedDirection).action : 'none',
                reversed: isReversed,
            });

            return {
                symbol,
                signal,
                confidence,
                reason: reasons,
                stopLoss: signal !== 'hold' ? Number(stopLoss?.toFixed(8)) : undefined,
                takeProfit: signal !== 'hold' ? Number(takeProfit?.toFixed(8)) : undefined,
                trailingStopDistance: signal !== 'hold' ? riskParams.trailingStopDistance : undefined,
                positionSizeMultiplier: signal !== 'hold' ? positionSizeMultiplier : undefined,
                mlConfidence: this.mlService.isReady() ? mlConfidence : undefined,
                features,
                potentialSignal  // ← NEW: Always include for scanner simulation triggering
            };
        } catch (err) {
            logger.error(`Signal generation failed for ${symbol}`, { error: (err as Error).stack });
            reasons.push(`Exception: ${(err as Error).message}`);
            return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [], potentialSignal: 'hold' };
        }
    }
}
