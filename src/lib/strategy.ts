// src/lib/strategy.ts
// ---------------------------------------------------------------
// STRATEGY ENGINE: High-frequency scalping signals (3m + 1h HTF)
// Goal: 0.5-1.5% per trade (realistic adjustment from original 2-3%), avoid false signals, respect trend
// ---------------------------------------------------------------

import type { ADXOutput } from 'technicalindicators/declarations/directionalmovement/ADX'; // ← Type for the ADX indicator output
import type { OhlcvData } from '../types';                                           // ← Custom type that holds OHLCV arrays for a symbol
import {
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateStochastic,
    calculateATR,
    calculateOBV,
    calculateVWMA,
    calculateVWAP,
    calculateADX,
    calculateMomentum,
    detectEngulfing,
} from './indicators';                                                             // ← All pure indicator functions (no side-effects)
import { createLogger } from './logger';                                             // ← Simple winston/pino wrapper used everywhere
import { MLService } from './services/mlService';                                    // ← Wrapper around a trained ML model (predicts buy/sell probability)

const logger = createLogger('Strategy');                                          // ← Dedicated logger for this module

// ---------------------------------------------------------------
// INTERFACES: Define input/output shapes
// ---------------------------------------------------------------
export interface TradeSignal {                                                    // ← What the engine finally returns to the caller
    symbol: string;                                                               // ← e.g. "BTCUSDT"
    signal: 'buy' | 'sell' | 'hold';                                              // ← Final decision
    confidence: number;                                                           // ← 0-100, derived from score + ML
    reason: string[];                                                             // ← Human-readable list of why we decided
    stopLoss?: number;                                                            // ← ATR-based stop price
    takeProfit?: number;                                                          // ← Risk:Reward target price
    trailingStopDistance?: number;                                                // ← How far the trailing stop follows price
    positionSizeMultiplier?: number;                                              // ← Scale position size by confidence (0-1)
    mlConfidence?: number;                                                        // ← Raw ML probability (optional if model not trained)
    features: number[];                                                           // ← Numeric vector fed to the ML model (for training later)
}

export interface StrategyInput {                                                  // ← Everything the engine needs from the outside
    symbol: string;
    primaryData: OhlcvData;                                                       // ← 3-minute candles (the "fast" timeframe)
    htfData: OhlcvData;                                                           // ← 1-hour candles (higher-timeframe trend filter)
    price: number;                                                                // ← Current market price (last trade or mid-price)
    atrMultiplier: number;                                                        // ← How many ATRs away the stop-loss is placed
    riskRewardTarget: number;                                                     // ← e.g. 2 = 2:1 reward:risk
    trailingStopPercent: number;                                                  // ← Kept for API compatibility, not used internally
}

// All calculated indicators stored here
interface Indicators {                                                            // ← Internal bucket – one place for every indicator value
    emaShort: number[];                                                           // ← Full EMA-20 series on 3m
    htfEmaMid: number[];                                                          // ← Full EMA-50 series on 1h
    vwma: number[];                                                               // ← Full VWMA-20 series on 3m
    vwap: number[];                                                               // ← Full VWAP series (same look-back as VWMA)
    rsi: number[];                                                                // ← Full RSI series
    macd: Array<{ MACD: number; signal: number; histogram: number }>;            // ← Full MACD object series
    stochastic: Array<{ k: number; d: number }>;                                  // ← Full Stochastic series
    atr: number[];                                                                // ← Full ATR series
    obv: number[];                                                                // ← Full On-Balance Volume series
    lastEmaShort: number;                                                         // ← Most recent EMA-20 value
    lastHtfEmaMid: number;                                                        // ← Most recent EMA-50 on 1h
    lastVwma20: number;                                                           // ← Most recent VWMA-20
    lastVwap: number;                                                             // ← Most recent VWAP
    rsiNow: number;                                                               // ← Current RSI
    macdNow: { MACD: number; signal: number; histogram: number } | undefined;    // ← Current MACD (may be undefined on first bars)
    stochNow: { k: number; d: number };                                           // ← Current Stochastic %K & %D
    lastObv: number;                                                              // ← Current OBV
    lastAtr: number;                                                              // ← Current ATR (used for stop-loss)
    htfAdx: ADXOutput[];                                                          // ← Full ADX series on 1h
    lastHtfAdx: ADXOutput;                                                        // ← Latest ADX values (adx, +DI, -DI)
    lastMomentum: number;                                                         // ← Latest 10-period momentum
    prevMomentum: number;                                                         // ← Momentum one bar ago (to detect acceleration)
}

// Trend + volume context
interface TrendAndVolume {                                                        // ← Summary of market regime
    hasVolumeSurge: boolean;                                                      // ← Did volume spike > 2× recent average?
    vwmaFalling: boolean;                                                         // ← Is VWMA sloping down?
    trendBias: 'bullish' | 'bearish' | 'neutral';                                 // ← Higher-timeframe bias
    isTrending: boolean;                                                          // ← ADX > 20 and one DI dominates
    engulfing: ("bullish" | "bearish" | null)[];                                  // ← Array of detected engulfing patterns (last element = current)
}

// Scoring output
interface ScoresAndML {                                                           // ← Result of the point-system + ML
    buyScore: number;
    sellScore: number;
    features: number[];                                                           // ← Same vector that will be sent to ML
    mlConfidence: number;                                                         // ← Highest probability returned by ML (0-1)
}

// ---------------------------------------------------------------
// SCORING CONSTANTS: Points system for signal strength (balanced for realism)
// ---------------------------------------------------------------
const CONFIDENCE_THRESHOLD = 70;              // ← Minimum raw score to even consider a trade
const SCORE_MARGIN_REQUIRED = 15;             // ← Buy must beat Sell by at least this many points

const EMA_ALIGNMENT_POINTS = 20;              // ← Price > EMA20 > HTF-EMA50 = strong alignment
const VWMA_VWAP_POINTS = 15;                  // ← VWMA above VWAP = volume-weighted bullishness
const MACD_POINTS = 15;                       // ← Full bullish MACD (crossover + positive histogram)
const RSI_POINTS = 10;                        // ← Classic overbought/oversold
const STOCH_POINTS = 10;                      // ← Stochastic reversal in extreme zones
const OBV_VWMA_POINTS = 10;                   // ← Volume confirming price direction
const ATR_POINTS = 10;                        // ← Volatility in a sane range (not too quiet, not crazy)
const VWMA_SLOPE_POINTS = 5;                  // ← Direction of VWMA itself
const ADX_POINTS = 10;                        // ← Confirms a trending market
const MOMENTUM_POINTS = 12;                   // ← Leading momentum acceleration
const ENGULFING_POINTS = 15;                  // ← Strong price-action candle

// Total possible points per side (used later to normalise confidence)
const MAX_SCORE_PER_SIDE =
    EMA_ALIGNMENT_POINTS +
    VWMA_VWAP_POINTS +
    MACD_POINTS +
    RSI_POINTS +
    STOCH_POINTS +
    OBV_VWMA_POINTS +
    ATR_POINTS +
    VWMA_SLOPE_POINTS +
    ADX_POINTS +
    MOMENTUM_POINTS +
    ENGULFING_POINTS;

const ML_CONFIDENCE_THRESHOLD = 0.7;          // ← Minimum ML confidence to trust its vote
const ML_CONFIDENCE_DISCOUNT = 0.8;           // ← If model not trained, cut its vote by 20%

const MIN_ATR_MULTIPLIER = 0.5;               // ← Safety bounds for stop-loss distance
const MAX_ATR_MULTIPLIER = 5;

const DEFAULT_COOLDOWN_MINUTES = 10;          // ← Don't spam signals – wait at least 10 min

const MIN_AVG_VOLUME_USD_PER_HOUR = 35_000;   // ≈ $2.4 M daily
const BEAR_MARKET_LIQUIDITY_MULTIPLIER = 1.5; // 50 % stricter in bear trends

// ---------------------------------------------------------------
// STRATEGY CLASS: Core logic
// ---------------------------------------------------------------
export class Strategy {
    // ----------------------------------------------------------------
    // PRIVATE FIELDS (tunable parameters & state)
    // ----------------------------------------------------------------
    private mlService: MLService;                                 // ← Injected ML wrapper
    private cooldownMinutes: number;                              // ← How long to wait between signals per symbol
    private lastSignalTimes: Map<string, number> = new Map();     // ← Timestamp of last *non-hold* signal per symbol
    public lastAtr: number = 0;                                  // ← Cached ATR (used for risk calc outside the class)

    // ---- Indicator periods (all hard-coded but could be made configurable) ----
    private emaShortPeriod: number = 20;                          // ← Fast EMA on 3m
    private htfEmaMidPeriod: number = 50;                         // ← Mid-term EMA on 1h (trend filter)
    private vwmaPeriod: number = 20;                              // ← VWMA look-back
    private rsiPeriod: number = 10;                               // ← Short RSI for scalping responsiveness
    private macdFast: number = 5;                                 // ← Very fast MACD (5-13-8)
    private macdSlow: number = 13;
    private macdSignal: number = 8;
    private stochK: number = 14;                                  // ← %K period
    private stochD: number = 3;                                   // ← %D smoothing
    private atrPeriod: number = 12;                               // ← Shorter ATR for volatility sensitivity
    private adxPeriod: number = 14;                               // ← ADX on 1h
    private obvLookback: number = 20;                              // ← How many bars to compare for volume surge
    private volumeSurgeMultiplier: number = 2;                    // ← Current volume > 2× avg of last 5 bars
    private minAdx: number = 20;                                  // ← ADX threshold for "trending"

    // ----------------------------------------------------------------
    // CONSTRUCTOR
    // ----------------------------------------------------------------
    constructor(mlService: MLService, cooldownMinutes: number = DEFAULT_COOLDOWN_MINUTES) {
        this.mlService = mlService;                               // ← Must be provided (even if dummy)
        this.cooldownMinutes = cooldownMinutes;
    }

    // ---------------------------------------------------------------
    // INDICATORS: Compute all at once
    // ---------------------------------------------------------------
    private _calculateIndicators(primaryData: OhlcvData, htfData: OhlcvData): Indicators {
        // ---- Calculate every indicator in one pass (avoid recomputing arrays) ----
        const emaShort = calculateEMA(primaryData.closes, this.emaShortPeriod);
        const htfEmaMid = calculateEMA(htfData.closes, this.htfEmaMidPeriod);
        const vwma = calculateVWMA(primaryData.closes, primaryData.volumes, this.vwmaPeriod);
        const vwap = calculateVWAP(primaryData.highs, primaryData.lows, primaryData.closes, primaryData.volumes, this.vwmaPeriod);
        const rsi = calculateRSI(primaryData.closes, this.rsiPeriod);
        const macd = calculateMACD(primaryData.closes, this.macdFast, this.macdSlow, this.macdSignal);
        const stochastic = calculateStochastic(primaryData.highs, primaryData.lows, primaryData.closes, this.stochK, this.stochD);
        const atr = calculateATR(primaryData.highs, primaryData.lows, primaryData.closes, this.atrPeriod);
        const obv = calculateOBV(primaryData.closes, primaryData.volumes);
        const htfAdx = calculateADX(htfData.highs, htfData.lows, htfData.closes, this.adxPeriod);
        const momentum = calculateMomentum(primaryData.closes, 10);

        // ---- Grab the *latest* values (most of the logic only needs the last bar) ----
        const lastEmaShort = emaShort[emaShort.length - 1] ?? 0;
        const lastHtfEmaMid = htfEmaMid[htfEmaMid.length - 1] ?? 0;
        const lastVwma20 = vwma[vwma.length - 1] ?? 0;
        const lastVwap = vwap[vwap.length - 1] ?? 0;
        const rsiNow = rsi[rsi.length - 1] ?? 50;
        let macdNow = macd[macd.length - 1];
        const stochNow = stochastic[stochastic.length - 1] ?? { k: 50, d: 50 };
        const lastObv = obv[obv.length - 1] ?? 0;
        const lastAtr = atr[atr.length - 1] ?? 0;
        const lastHtfAdx = htfAdx[htfAdx.length - 1] ?? { adx: 0, pdi: 0, mdi: 0 };
        const lastMomentum = momentum[momentum.length - 1] ?? 0;
        const prevMomentum = momentum[momentum.length - 2] ?? 0;

        // ---- MACD can produce NaN on the very first bars – fallback to previous bar ----
        if (macdNow && (isNaN(macdNow.MACD) || isNaN(macdNow.signal) || isNaN(macdNow.histogram))) {
            logger.warn('NaN detected in MACD, falling back to previous value');
            macdNow = macd[macd.length - 2] ?? { MACD: 0, signal: 0, histogram: 0 };
        }

        return {
            emaShort,
            htfEmaMid,
            vwma,
            vwap,
            rsi,
            macd,
            stochastic,
            atr,
            obv,
            lastEmaShort,
            lastHtfEmaMid,
            lastVwma20,
            lastVwap,
            rsiNow,
            macdNow,
            stochNow,
            lastObv,
            lastAtr,
            htfAdx,
            lastHtfAdx,
            lastMomentum,
            prevMomentum,
        };
    }

    // ---------------------------------------------------------------
    // TREND + VOLUME: Analyze context (added liquidity check)
    // ---------------------------------------------------------------
    private _analyzeTrendAndVolume( primaryData: OhlcvData, indicators: Indicators, _price: number): TrendAndVolume {
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

        // Calculate average volume in USD
        const avgBaseVol = volSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;
        const avgPrice = priceSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;
        const avgVolumeUSD = avgBaseVol * avgPrice;

        // Determine 1h trend bias (used for dynamic liquidity and final output)
        const { adx, pdi, mdi } = indicators.lastHtfAdx;
        const isTrending = adx > this.minAdx;
        const trendBias = isTrending
            ? pdi > mdi
                ? 'bullish'
                : 'bearish'
            : 'neutral';

        // Apply Dynamic Liquidity Threshold: stricter in bear markets
        const baseThreshold = MIN_AVG_VOLUME_USD_PER_HOUR;
        const bearMultiplier =
            trendBias === 'bearish' ? BEAR_MARKET_LIQUIDITY_MULTIPLIER : 1.0;
        const threshold = baseThreshold * bearMultiplier;
        const hasLiquidity = avgVolumeUSD >= threshold;

        // ------------------------------------------------------------------
        // 2. ENGULFING (run always – cheap)
        // ------------------------------------------------------------------
        const engulfing = detectEngulfing(
            primaryData.opens,
            primaryData.highs,
            primaryData.lows,
            primaryData.closes
        );

        // EARLY EXIT: If liquidity fails, we return a neutral signal
        if (!hasLiquidity) {
            logger.info(
                `Low liquidity ${primaryData.symbol}: ` +
                `$${avgVolumeUSD.toFixed(0)}/hr < $${threshold.toFixed(0)} ` +
                `(trend=${trendBias})`
            );
            return this._neutral();
        }

        // ------------------------------------------------------------------
        // 3. VOLUME SURGE – Current volume vs. previous N bars (all in USD)
        // ------------------------------------------------------------------
        const lookback = this.obvLookback; // Use obvLookback for short-term volume average
        const recentVols = primaryData.volumes.slice(-lookback - 1, -1);
        const recentPrices = primaryData.closes.slice(-lookback - 1, -1);

        // Calculate average previous volume in USD
        const avgPrevUSD =
            recentVols.reduce((sum, v, i) => sum + v * recentPrices[i], 0) /
            lookback;

        // Calculate current volume in USD
        const currentVolUSD =
            primaryData.volumes[primaryData.volumes.length - 1] *
            primaryData.closes[primaryData.closes.length - 1];

        const hasVolumeSurge = currentVolUSD > avgPrevUSD * this.volumeSurgeMultiplier;

        // ------------------------------------------------------------------
        // 4. VWMA slope
        // ------------------------------------------------------------------
        const vwmaSlope =
            indicators.lastVwma20 -
            (indicators.vwma[indicators.vwma.length - 2] ?? indicators.lastVwma20);
        const vwmaFalling = vwmaSlope < 0;

        // ------------------------------------------------------------------
        // 5. RETURN (ADX/Trend Bias variables are already set in Section 1)
        // ------------------------------------------------------------------
        return {
            hasVolumeSurge,
            vwmaFalling,
            trendBias, // From Section 1
            isTrending, // From Section 1
            engulfing,
        };
    }

    /** Helper – keeps the early-exit return DRY */
    private _neutral(): TrendAndVolume {
        return {
            hasVolumeSurge: false,
            vwmaFalling: false,
            trendBias: 'neutral',
            isTrending: false,
            engulfing: [null],
        };
    }

    // ---------------------------------------------------------------
    // SCORES: Compute buy/sell points (completed sell-side, tiered scoring)
    // ---------------------------------------------------------------
    private _computeScores(
        indicators: Indicators,
        trendAndVolume: TrendAndVolume,
        input: StrategyInput,
        reasons: string[]                                   // ← mutated in-place with human explanations
    ): ScoresAndML {
        let buyScore = 0;
        let sellScore = 0;

        // -------------------- EMA ALIGNMENT --------------------
        if (input.price > indicators.lastEmaShort && indicators.lastEmaShort > indicators.lastHtfEmaMid) {
            buyScore += EMA_ALIGNMENT_POINTS;
            reasons.push('Bullish EMA alignment: Price > EMA20 > HTF EMA50');
        } else if (input.price < indicators.lastEmaShort && indicators.lastEmaShort < indicators.lastHtfEmaMid) {
            sellScore += EMA_ALIGNMENT_POINTS;
            reasons.push('Bearish EMA alignment: Price < EMA20 < HTF EMA50');
        }

        // -------------------- VWMA vs VWAP --------------------
        if (indicators.lastVwma20 > indicators.lastVwap) {
            buyScore += VWMA_VWAP_POINTS;
            reasons.push('Bullish VWMA > VWAP');
        } else if (indicators.lastVwma20 < indicators.lastVwap) {
            sellScore += VWMA_VWAP_POINTS;
            reasons.push('Bearish VWMA < VWAP');
        }

        // -------------------- MACD (tiered) --------------------
        if (indicators.macdNow) {
            const macdCrossUp = indicators.macdNow.MACD > indicators.macdNow.signal;
            const histPositive = indicators.macdNow.histogram > 0;
            if (macdCrossUp && histPositive) {
                buyScore += MACD_POINTS;
                reasons.push('Strong Bullish MACD: Crossover + Positive Histogram');
            } else if (macdCrossUp) {
                buyScore += MACD_POINTS / 2;
                reasons.push('Weak Bullish MACD: Crossover but Histogram not positive');
            }

            const macdCrossDown = indicators.macdNow.MACD < indicators.macdNow.signal;
            const histNegative = indicators.macdNow.histogram < 0;
            if (macdCrossDown && histNegative) {
                sellScore += MACD_POINTS;
                reasons.push('Strong Bearish MACD: Crossover + Negative Histogram');
            } else if (macdCrossDown) {
                sellScore += MACD_POINTS / 2;
                reasons.push('Weak Bearish MACD: Crossover but Histogram not negative');
            }
        }

        // -------------------- RSI --------------------
        if (indicators.rsiNow < 30) {
            buyScore += RSI_POINTS;
            reasons.push('Oversold RSI <30');
        } else if (indicators.rsiNow > 70) {
            sellScore += RSI_POINTS;
            reasons.push('Overbought RSI >70');
        }

        // -------------------- STOCHASTIC --------------------
        if (indicators.stochNow.k < 20 && indicators.stochNow.k > indicators.stochNow.d) {
            buyScore += STOCH_POINTS;
            reasons.push('Bullish Stochastic crossover in oversold');
        } else if (indicators.stochNow.k > 80 && indicators.stochNow.k < indicators.stochNow.d) {
            sellScore += STOCH_POINTS;
            reasons.push('Bearish Stochastic crossover in overbought');
        }

        // -------------------- OBV + VWMA --------------------
        const obvRising = indicators.lastObv > (indicators.obv[indicators.obv.length - 2] ?? indicators.lastObv);
        if (obvRising && indicators.lastVwma20 > input.price) {
            buyScore += OBV_VWMA_POINTS;
            reasons.push('Bullish OBV rising with VWMA support');
        } else if (!obvRising && indicators.lastVwma20 < input.price) {
            sellScore += OBV_VWMA_POINTS;
            reasons.push('Bearish OBV falling with VWMA resistance');
        }

        // -------------------- ATR VOLATILITY RANGE --------------------
        const atrPct = (indicators.lastAtr / input.price) * 100;
        if (atrPct > 0.2 && atrPct < 5) { // Scalping-friendly volatility
            buyScore += ATR_POINTS;
            sellScore += ATR_POINTS;
            reasons.push(`Sane ATR volatility: ${atrPct.toFixed(2)}%`);
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
            buyScore += ADX_POINTS;
            sellScore += ADX_POINTS;
            reasons.push(`Strong trend confirmed by ADX >${this.minAdx}`);
        }

        // -------------------- MOMENTUM ACCELERATION --------------------
        if (indicators.lastMomentum > 0 && indicators.lastMomentum > indicators.prevMomentum) {
            buyScore += MOMENTUM_POINTS;
            reasons.push('Bullish Momentum acceleration');
        } else if (indicators.lastMomentum < 0 && indicators.lastMomentum < indicators.prevMomentum) {
            sellScore += MOMENTUM_POINTS;
            reasons.push('Bearish Momentum deceleration');
        }

        // -------------------- ENGULFING PATTERN --------------------
        const lastPattern = trendAndVolume.engulfing[trendAndVolume.engulfing.length - 1];
        if (lastPattern === 'bullish') {
            buyScore += ENGULFING_POINTS;
            reasons.push('Bullish Engulfing candle');
        } else if (lastPattern === 'bearish') {
            sellScore += ENGULFING_POINTS;
            reasons.push('Bearish Engulfing candle');
        }

        // -------------------- ML FEATURE VECTOR --------------------
        const features = this.mlService.extractFeatures(input);

        // -------------------- ML PREDICTION --------------------
        let mlConfidence = 0;
        if (this.mlService.isModelTrained()) {
            const buyProb = this.mlService.predict(features, 1);   // 1 = buy label
            const sellProb = this.mlService.predict(features, -1); // -1 = sell label
            mlConfidence = Math.max(buyProb, sellProb);           // Highest probability wins
            reasons.push(`ML Confidence: ${mlConfidence.toFixed(2)}`);
        } else {               // Penalise untrained model
            reasons.push('ML untrained: Confidence discounted');
        }

        return { buyScore, sellScore, features, mlConfidence };
    }

    // ---------------------------------------------------------------
    // SIGNAL: Determine final action (added trend/ML gates)
    // ---------------------------------------------------------------
    private _determineSignal(
        buyScore: number,
        sellScore: number,
        trendBias: TrendAndVolume['trendBias'],
        mlConfidence: number,
        isRiskEligible: boolean,
        reasons: string[]
    ): { signal: TradeSignal['signal']; confidence: number } {
        // ---- Risk sanity check first (ATR % out of bounds → hold) ----
        if (!isRiskEligible) {
            reasons.push('Risk ineligible: ATR out of bounds');
            return { signal: 'hold', confidence: 0 };
        }

        // ---- Debug raw numbers (kept for dev) ----
        let isMlModelTrained = this.mlService.isModelTrained();

        // ---- ML gate (optional – currently commented out) ----
        if (isMlModelTrained && mlConfidence < ML_CONFIDENCE_THRESHOLD) {
            reasons.push(`ML confidence too low: ${mlConfidence} < ${ML_CONFIDENCE_THRESHOLD}`);
            return { signal: 'hold', confidence: 0 };
        }

        const maxScore = MAX_SCORE_PER_SIDE;
        let signal: TradeSignal['signal'] = 'hold';
        let confidence = 0;
        let mlDiscount = isMlModelTrained ? mlConfidence : ML_CONFIDENCE_DISCOUNT;

        // ---- BUY PATH ----
        if (trendBias === 'bullish' && buyScore >= CONFIDENCE_THRESHOLD && buyScore - sellScore >= SCORE_MARGIN_REQUIRED) {
            signal = 'buy';
            confidence = (buyScore / maxScore) * 100 * mlDiscount; // Combine rule-based score + ML
        }
        // ---- SELL PATH ----
        else if (trendBias === 'bearish' && sellScore >= CONFIDENCE_THRESHOLD && sellScore - buyScore >= SCORE_MARGIN_REQUIRED) {
            signal = 'sell';
            confidence = (sellScore / maxScore) * 100 * mlDiscount;
        }
        // ---- NO CLEAR SIGNAL ----
        else {
            reasons.push('No clear signal: Insufficient score margin or trend mismatch');
        }

        confidence = Math.min(confidence, 100); // Never exceed 100%

        return { signal, confidence };
    }

    // ---------------------------------------------------------------
    // RISK ELIGIBILITY: Sanity check (simplified to ATR % bounds)
    // ---------------------------------------------------------------
    private _isRiskEligible(price: number, lastAtr: number): boolean {
        const atrPct = (lastAtr / price) * 100;
        return atrPct > 0.2 && atrPct < 5; // Volatility must be tradeable
    }

    // ---------------------------------------------------------------
    // RISK MANAGEMENT: SL, TP, Trailing (tighter RR for realism)
    // ---------------------------------------------------------------
    private _computeRiskParams(
        signal: TradeSignal['signal'],
        price: number,
        atrMultiplier: number,
        riskRewardTarget: number,
        confidence: number,
        lastAtr: number
    ): {
        stopLoss?: number;
        takeProfit?: number;
        trailingStopDistance?: number;
        positionSizeMultiplier?: number;
    } {
        // Clamp multiplier to safe range
        const adj = Math.min(Math.max(atrMultiplier, MIN_ATR_MULTIPLIER), MAX_ATR_MULTIPLIER);
        const riskDist = lastAtr * adj;                     // Distance from entry to stop

        const stopLoss =
            signal === 'buy' ? price - riskDist : signal === 'sell' ? price + riskDist : undefined;
        const takeProfit =
            signal === 'buy'
                ? price + riskDist * riskRewardTarget
                : signal === 'sell'
                    ? price - riskDist * riskRewardTarget
                    : undefined;

        // Trailing stop gets tighter the *higher* the confidence
        const trailingStopDistance = signal !== 'hold' ? riskDist * (1 - confidence / 200) : undefined;

        // Higher confidence → larger position (capped at 1×)
        const positionSizeMultiplier = signal !== 'hold' ? Math.min(confidence / 100, 1) : undefined;

        return { stopLoss, takeProfit, trailingStopDistance, positionSizeMultiplier };
    }

    // ---------------------------------------------------------------
    // PUBLIC: Generate signal (added liquidity in trend analysis)
    // ---------------------------------------------------------------
    public generateSignal(input: StrategyInput): TradeSignal {
        const reasons: string[] = [];
        const { symbol, primaryData, htfData, price, atrMultiplier, riskRewardTarget } = input;

        // ---- COOLDOWN CHECK (per-symbol) ----
        const now = Date.now();
        const last = this.lastSignalTimes.get(symbol) ?? 0;
        if ((now - last) / (1000 * 60) < this.cooldownMinutes) {
            reasons.push(`Cooldown active (last signal <${this.cooldownMinutes} min ago)`);
            return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
        }

        try {
            // ---- DATA LENGTH VALIDATION (need enough bars for every indicator) ----
            const required = Math.max(
                this.emaShortPeriod,
                this.vwmaPeriod,
                this.rsiPeriod,
                this.atrPeriod,
                this.macdSlow + this.macdSignal,
                this.adxPeriod
            );
            if (
                primaryData.closes.length < required ||
                htfData.closes.length < this.htfEmaMidPeriod
            ) {
                reasons.push('Insufficient OHLCV data for indicator calculation');
                return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
            }

            // ---- 1. CALCULATE ALL INDICATORS ----
            const indicators = this._calculateIndicators(primaryData, htfData);
            this.lastAtr = indicators.lastAtr; // cache for external use if needed

            // ---- 2. TREND + VOLUME CONTEXT (includes liquidity filter) ----
            const trendAndVolume = this._analyzeTrendAndVolume(primaryData, indicators, price);
            if (!trendAndVolume.isTrending) {
                reasons.push('No trending market: Holding');
                return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
            }

            // ---- 3. POINT-BASED SCORING + ML ----
            const { buyScore, sellScore, features, mlConfidence } = this._computeScores(
                indicators,
                trendAndVolume,
                input,
                reasons
            );

            // ---- 4. FINAL SIGNAL DECISION ----
            const { signal, confidence } = this._determineSignal(
                buyScore,
                sellScore,
                trendAndVolume.trendBias,
                mlConfidence,
                this._isRiskEligible(price, indicators.lastAtr),
                reasons
            );

            // ---- 5. RISK PARAMETERS (SL/TP/Trailing/Size) ----
            const risk = this._computeRiskParams(
                signal,
                price,
                atrMultiplier,
                riskRewardTarget,
                confidence,
                indicators.lastAtr
            );

            // ---- 6. RECORD COOLDOWN (only for real trades) ----
            if (signal !== 'hold') {
                this.lastSignalTimes.set(symbol, now);
            }

            // ---- 7. RETURN FULL SIGNAL OBJECT ----
            return {
                symbol,
                signal,
                confidence,
                reason: reasons,
                stopLoss: risk.stopLoss,
                takeProfit: risk.takeProfit,
                trailingStopDistance: risk.trailingStopDistance,
                positionSizeMultiplier: risk.positionSizeMultiplier,
                mlConfidence: this.mlService.isModelTrained() ? mlConfidence : undefined,
                features,
            };
        } catch (err) {
            // ---- GLOBAL ERROR HANDLING (never crash the bot) ----
            logger.error(`Error generating signal for ${symbol}`, { err });
            reasons.push(`Exception: ${(err as Error).message}`);
            return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
        }
    }
}
