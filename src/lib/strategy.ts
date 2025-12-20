// src/lib/strategy.ts
// ---------------------------------------------------------------
// STRATEGY ENGINE: High-frequency scalping signals (3m + 1h HTF)
// Now enhanced with:
//   • Centralized indicators via indicatorUtils
//   • Excursion-based dynamic adjustments (MAE/MFE)
//   • Adaptive SL/TP, confidence, and risk sizing
// ---------------------------------------------------------------

import type { OhlcvData, SignalLabel, TradeSignal } from '../types';                          // ← NEW: For excursion stats
import { createLogger } from './logger';
import { MLService } from './services/mlService';
import { config } from './config/settings';
import { computeIndicators, type IndicatorMap } from './utils/indicatorUtils';
import { dbService } from './db';
import { getExcursionAdvice } from './utils/excursionUtils';
import { detectEngulfing } from './indicators';

const logger = createLogger('Strategy');                                          // ← Dedicated logger for this module

export interface StrategyInput {                                                  // ← Everything the engine needs from the outside
    symbol: string;
    primaryData: OhlcvData;                                                       // ← 3-minute candles (the "fast" timeframe)
    htfData: OhlcvData;                                                           // ← 1-hour candles (higher-timeframe trend filter)
    price: number;                                                                // ← Current market price (last trade or mid-price)
    atrMultiplier: number;                                                        // ← How many ATRs away the stop-loss is placed
    riskRewardTarget: number;                                                     // ← e.g. 2 = 2:1 reward:risk
    trailingStopPercent: number;                                                  // ← Kept for API compatibility, not used internally
}

// Trend + volume context
interface TrendAndVolume {                                                        // ← Summary of market regime
    hasVolumeSurge: boolean;                                                      // ← Did volume spike > 2× recent average?
    vwmaFalling: boolean;                                                         // ← Is VWMA sloping down?
    trendBias: 'bullish' | 'bearish' | 'neutral';                                 // ← Higher-timeframe bias
    isTrending: boolean;                                                          // ← ADX > 20 and one DI dominates
    engulfing: ("bullish" | "bearish" | null)[];                                  // ← Array of detected engulfing patterns (last element = current)
}

interface ScoresAndML {                                                           // ← Result of the point-system + ML
    buyScore: number;
    sellScore: number;
    features: number[];                                                           // ← Same vector that will be sent to ML
    mlConfidence: number;                                                         // ← Highest probability returned by ML (0-1)
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

const MIN_ATR_PCT = 0.5;                      // ← Realistic volatility range for crypto scalping
const MAX_ATR_PCT = 20;

const MIN_BB_BANDWIDTH_PCT = 0.3;             // ← Minimum Bollinger Band width percentage to avoid flat markets

const RELATIVE_VOLUME_MULTIPLIER = 1.5;       // ← Multiplier for relative volume check

const MIN_DI_DIFF = 4;                       // ← Minimum difference between +DI and -DI for trend dominance

const MIN_ADX = 20;                          // ← Minimum ADX for trend dominance
const VOLUME_SURGE_MULTIPLIER = 2;            // ← Multiplier for volume surge

export class Strategy {
    private mlService: MLService;
    private cooldownMinutes: number;
    private lastSignalTimes: Map<string, number> = new Map();
    public lastAtr: number = 0;

    constructor(mlService: MLService, cooldownMinutes: number = DEFAULT_COOLDOWN_MINUTES) {
        this.mlService = mlService;
        this.cooldownMinutes = cooldownMinutes;
    }

    // ---------------------------------------------------------------
    // TREND + VOLUME: Analyze context (added liquidity check)
    // ---------------------------------------------------------------
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

        // Calculate average volume in USD
        const avgBaseVol = volSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;
        const avgPrice = priceSlice.slice(0, len).reduce((a, b) => a + b, 0) / len;
        const avgVolumeUSD = avgBaseVol * avgPrice;

        // Determine 1h trend bias (used for dynamic liquidity and final output)
        const { htfAdx: adx, htfPdi: pdi, htfMdi: mdi } = indicators.last;
        const diDiff = Math.abs(pdi - mdi);
        console.log(`ADX Analysis for ${primaryData.symbol}: ADX=${adx.toFixed(2)}, +DI=${pdi.toFixed(2)}, -DI=${mdi.toFixed(2)}, DI Diff=${diDiff.toFixed(2)}`);
        const isTrending = adx > MIN_ADX && diDiff > MIN_DI_DIFF;
        const trendBias = isTrending
            ? pdi > mdi
                ? 'bullish'
                : 'bearish'
            : 'neutral';

        // Apply Dynamic Liquidity Threshold: stricter in bear markets
        const baseThreshold = MIN_AVG_VOLUME_USD_PER_HOUR;
        const bullMultiplier =
            trendBias === 'bullish' && adx > 35 ? BULL_MARKET_LIQUIDITY_MULTIPLIER : 1.0;
        const threshold = baseThreshold * bullMultiplier;
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
        const lookback = 20; // Use obvLookback for short-term volume average
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

        let hasVolumeSurge = currentVolUSD > avgPrevUSD * VOLUME_SURGE_MULTIPLIER;

        // Add relative volume check (base volume)
        const volLookback = 20;
        const recentBaseVols = primaryData.volumes.slice(-volLookback - 1, -1);
        const avgBaseVol20 = recentBaseVols.reduce((sum, v) => sum + v, 0) / volLookback;
        const currentBaseVol = primaryData.volumes[primaryData.volumes.length - 1];
        const hasRelativeVolumeSurge = currentBaseVol > avgBaseVol20 * RELATIVE_VOLUME_MULTIPLIER;

        hasVolumeSurge = hasVolumeSurge && hasRelativeVolumeSurge;

        // ------------------------------------------------------------------
        // 4. VWMA slope
        // ------------------------------------------------------------------
        const vwmaSlope = indicators.last.vwma -
            (indicators.vwma[indicators.vwma.length - 2] ?? indicators.last.vwma);
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

        // -------------------- MACD (tiered) --------------------
        // Ensure MACD fields are numeric (some indicator implementations may return undefined)
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

            // -------------------- MACD ZERO LINE --------------------
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

        // -------------------- OBV + VWMA (clarified for momentum) --------------------
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
        if (atrPct > MIN_ATR_PCT && atrPct < MAX_ATR_PCT) { // Tighter range for crypto scalping
            buyScore += ATR_POINTS;
            sellScore += ATR_POINTS;
            reasons.unshift(`Sane ATR volatility: ${atrPct.toFixed(2)}%`);
        }

        // -------------------- VWMA SLOPE --------------------
        //
        if (!trendAndVolume.vwmaFalling) {
            buyScore += VWMA_SLOPE_POINTS;
            reasons.push('Bullish VWMA slope');
        } else {
            sellScore += VWMA_SLOPE_POINTS;
            reasons.push('Bearish VWMA slope');
        }

        // -------------------- ADX TREND STRENGTH --------------------
        if (trendAndVolume.isTrending) {
            buyScore += trendAndVolume.trendBias === 'bullish' ? ADX_POINTS : 0;
            sellScore += trendAndVolume.trendBias === 'bearish' ? ADX_POINTS : 0;;
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
        // -------------------- ML PREDICTION – 5-TIER MODEL INTEGRATION (FINAL & CORRECT) --------------------
        const features = await this.mlService.extractFeatures(input);

        let mlWinConfidence = 0;        // Probability of good/great trade (label 1 or 2)
        let mlLossConfidence = 0;       // Approximate probability of loss (label -1 or -2)
        let predictedLabel: SignalLabel = 0;

        if (this.mlService.isReady()) {
            const prediction = this.mlService.predict(features);  // Only 1 argument!

            predictedLabel = prediction.label;        // -2, -1, 0, 1, or 2
            mlWinConfidence = prediction.confidence;  // P(label >= 1) — already calculated in MLService
            mlLossConfidence = 1 - mlWinConfidence;    // Rough proxy for bearish confidence

            // Add bonus points based on prediction strength
            if (predictedLabel >= 1) {
                const bonus = mlWinConfidence * ML_BONUS_MAX;
                buyScore += bonus;
                reasons.unshift(`ML PREDICTS WIN (label ${predictedLabel}) → +${bonus.toFixed(0)}pts (${(mlWinConfidence * 100).toFixed(1)}%)`);
            } else if (predictedLabel <= -1) {
                const bonus = mlLossConfidence * ML_BONUS_MAX * 0.9; // Slightly less aggressive on shorts
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
            // Optional: small discount on all technical scores
            buyScore *= ML_CONFIDENCE_DISCOUNT;
            sellScore *= ML_CONFIDENCE_DISCOUNT;
        }

        return { buyScore, sellScore, features, mlConfidence: mlWinConfidence };
    }

    // ---------------------------------------------------------------
    // SIGNAL: Determine final action (added trend/ML gates)
    // ---------------------------------------------------------------
    private _determineSignal(
        buyScore: number,
        sellScore: number,
        trendBias: TrendAndVolume['trendBias'],
        isRiskEligible: boolean,
        reasons: string[]
    ): { signal: TradeSignal['signal']; confidence: number } {
        // ---- Risk sanity check first (ATR % out of bounds → hold) ----
        if (!isRiskEligible) {
            reasons.push('Risk ineligible: ATR out of bounds');
            return { signal: 'hold', confidence: 0 };
        }

        // ---- Apply counter-trend penalty (not full block) ----
        if (buyScore > sellScore) {
            if (trendBias !== 'bullish' && trendBias !== 'neutral') {
                buyScore *= 0.8; // 20% penalty for counter-trend
                reasons.push('Counter-trend buy: 20% score penalty applied');
            }
        } else if (sellScore > buyScore) {
            if (trendBias !== 'bearish' && trendBias !== 'neutral') {
                sellScore *= 0.8; // 20% penalty for counter-trend
                reasons.push('Counter-trend sell: 20% score penalty applied');
            }
        }

        // ---- Dynamic score margin (easier for high scores) ----
        const dynamicMargin = Math.min(SCORE_MARGIN_REQUIRED, CONFIDENCE_THRESHOLD * 0.29);

        // ---- BUY PATH ----
        let signal: TradeSignal['signal'] = 'hold';
        let confidence = 0;
        if (buyScore >= CONFIDENCE_THRESHOLD && buyScore - sellScore >= dynamicMargin) {
            signal = 'buy';
            confidence = (buyScore / MAX_SCORE_PER_SIDE) * 100;
        }
        // ---- SELL PATH ----
        else if (sellScore >= CONFIDENCE_THRESHOLD && sellScore - buyScore >= dynamicMargin) {
            signal = 'sell';
            confidence = (sellScore / MAX_SCORE_PER_SIDE) * 100;
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
        return atrPct > MIN_ATR_PCT && atrPct < MAX_ATR_PCT; // Tighter for realistic scalping
    }

    // ---------------------------------------------------------------
    // RISK MANAGEMENT: SL, TP, Trailing (tighter RR for realism)
    // ---------------------------------------------------------------
    /**
 * COMPUTE RISK PARAMETERS + DYNAMIC POSITION SIZING (2025 Scalping Best Practice)
 *
 * Key upgrades:
 *  - Fixed % risk per trade (0.25%–0.75% depending on trend & confidence)
 *  - Confidence-scaled position size (70+ → full size, 90+ → up to +50% bonus)
 *  - Bear-market auto-reduction
 *  - Max 5× effective leverage cap
 *  - Realistic trailing stop (75% of initial risk distance)
 */
    private _computeRiskParams(
        signal: TradeSignal['signal'],
        price: number,
        atrMultiplier: number,
        riskRewardTarget: number,
        confidence: number,
        lastAtr: number,
        trendBias: TrendAndVolume['trendBias'],        // ← Now required from trend analysis
        accountBalance: number | undefined = 1000                          // ← Must be passed from bot/exchange context
    ): {
        stopLoss?: number;
        takeProfit?: number;
        trailingStopDistance?: number;
        positionSizeUsd: number;                        // ← Absolute USD size (recommended)
        positionSizeMultiplier?: number;                // ← Kept for backward compat (0–1.5)
        riskAmountUsd: number;                          // ← How much $ you're actually risking
    } {
        if (signal === 'hold') {
            // No valid signal → nothing to risk
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
        // 1. Base risk % per trade (this is the core of survival)
        // ──────────────────────────────────────────────────────────────
        const BASE_RISK_PERCENT_BULL = 0.005;   // 0.50% in bullish/neutral markets
        const BASE_RISK_PERCENT_BEAR = 0.0025;  // 0.25% in bearish markets (volatility kills)
        const MAX_RISK_BONUS_CONFIDENCE = 0.005;  // +0.50% extra at 100 confidence

        const baseRiskPercent = trendBias === 'bearish'
            ? BASE_RISK_PERCENT_BEAR
            : BASE_RISK_PERCENT_BULL;

        // Confidence scaling: linear from 70 → 100 confidence = 1x → 1.5x base risk
        const confidenceFactor = Math.min((confidence - 70) / 30, 1); // 0 to 1
        const bonusRiskPercent = confidenceFactor * MAX_RISK_BONUS_CONFIDENCE;

        const finalRiskPercent = baseRiskPercent + bonusRiskPercent;
        const riskAmountUsd = accountBalance * finalRiskPercent;

        // ──────────────────────────────────────────────────────────────
        // 2. Stop-loss distance (ATR-based)
        // ──────────────────────────────────────────────────────────────
        const clampedMultiplier = Math.min(Math.max(atrMultiplier, MIN_ATR_MULTIPLIER), MAX_ATR_MULTIPLIER);
        const riskDistance = lastAtr * clampedMultiplier; // e.g., 1.5 × ATR

        // Prevent insane stops (should never happen but safety first)
        if (riskDistance <= 0 || riskDistance / price > 0.10) { // >10% stop = broken data
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
        // 3. Calculate actual position size in USD
        // ──────────────────────────────────────────────────────────────
        const rawPositionSizeUsd = riskAmountUsd / (riskDistance / price);

        // Hard cap: never exceed 5× effective leverage (scalping rule of thumb)
        const maxAllowedNotional = accountBalance * 5.0;
        const positionSizeUsd = Math.min(rawPositionSizeUsd, maxAllowedNotional);

        // ──────────────────────────────────────────────────────────────
        // 4. Stop Loss & Take Profit levels
        // ──────────────────────────────────────────────────────────────
        const stopLoss = signal === 'buy'
            ? price - riskDistance
            : price + riskDistance;

        const takeProfit = signal === 'buy'
            ? price + riskDistance * riskRewardTarget
            : price - riskDistance * riskRewardTarget;

        // ──────────────────────────────────────────────────────────────
        // 5. Trailing stop: 75% of initial risk distance (aggressive but proven)
        // ──────────────────────────────────────────────────────────────
        const trailingStopDistance = riskDistance * 0.75;

        // ──────────────────────────────────────────────────────────────
        // 6. Legacy multiplier (0–1.5) for systems still using it
        // ──────────────────────────────────────────────────────────────
        const positionSizeMultiplier = Math.min(positionSizeUsd / accountBalance * 5, 1.5);

        // ──────────────────────────────────────────────────────────────
        // Final return
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

    public async generateSignal(input: StrategyInput): Promise<TradeSignal> {
        const reasons: string[] = [];
        const { symbol, primaryData, htfData, price, atrMultiplier, riskRewardTarget } = input;

        const now = Date.now();
        const last = this.lastSignalTimes.get(symbol) ?? 0;
        if ((now - last) / (1000 * 60) < this.cooldownMinutes) {
            reasons.push(`Cooldown active (<${this.cooldownMinutes} min since last signal)`);
            return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
        }

        try {
            // === 1. Centralized indicator calculation ===
            const indicators = computeIndicators(primaryData, htfData);
            this.lastAtr = indicators.last.atr;

            // === 2. Fetch excursion history ===
            const excursions = await dbService.getSymbolExcursions(symbol);
            let excursionAdvice = '⚪ No excursion history yet';
            let adjustments = { slMultiplier: 1.0, tpMultiplier: 1.0, confidenceBoost: 0 };

            if (excursions && excursions.avgMae > 0) {
                const adviceObj = getExcursionAdvice(excursions.avgMfe, excursions.avgMae);
                excursionAdvice = adviceObj.advice;
                adjustments = adviceObj.adjustments;
                reasons.push(excursionAdvice);
            } else {
                reasons.push(excursionAdvice);
            }

            // ---- 3. TREND + VOLUME CONTEXT (includes liquidity filter) ----
            const trendAndVolume = this._analyzeTrendAndVolume(primaryData, indicators, price);
            if (!trendAndVolume.isTrending) {
                reasons.push('No trending market: Holding');
                if (config.env === 'dev') {
                    logger.info(`[DEV] ${symbol} not trending per ADX – holding`);
                }
                return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
            }

            // ---- 4 Check Bollinger Band width for flat markets ----
            if (indicators.last.bbBandwidth < MIN_BB_BANDWIDTH_PCT) {
                reasons.push(`Flat market detected: Bollinger Bandwidth ${indicators.last.bbBandwidth.toFixed(2)}% < ${MIN_BB_BANDWIDTH_PCT}%`);
                if (config.env === 'dev') {
                    logger.info(`[DEV] ${symbol} flat market per BB width – holding`);
                }
                return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
            }

            // ---- 5. POINT-BASED SCORING + ML ----
            let { buyScore, sellScore, features, mlConfidence } = await this._computeScores(
                indicators,
                trendAndVolume,
                input,
                reasons
            );

            // === 7. Apply excursion confidence boost ===
            buyScore += adjustments.confidenceBoost * 20;
            sellScore += adjustments.confidenceBoost * 20; // symmetric for now

            // ---- 6. FINAL SIGNAL DECISION ----
            const { signal, confidence } = this._determineSignal(
                buyScore,
                sellScore,
                trendAndVolume.trendBias,
                this._isRiskEligible(price, indicators.last.atr),
                reasons
            );

            // ---- 7. RISK PARAMETERS (SL/TP/Trailing/Size) ----
            const { stopLoss, takeProfit, trailingStopDistance, positionSizeMultiplier } = this._computeRiskParams(
                signal,
                price,
                atrMultiplier,
                riskRewardTarget,
                confidence,
                indicators.last.atr,
                trendAndVolume.trendBias,
            );

            if (signal !== 'hold') {
                this.lastSignalTimes.set(symbol, now);
            }

            if (config.env === 'dev') {
                logger.info(`[DEV] ${symbol} Signal: ${signal.toUpperCase()} @ ${price.toFixed(8)} | Confidence: ${confidence.toFixed(2)}% | buyScore: ${buyScore.toFixed(1)} | sellScore: ${sellScore.toFixed(1)} | ATR: ${indicators.last.atr.toFixed(4)}`);
            }

            return {
                symbol,
                signal,
                confidence,
                reason: reasons,
                stopLoss: signal !== 'hold' ? Number(stopLoss?.toFixed(8)) : undefined,
                takeProfit: signal !== 'hold' ? Number(takeProfit?.toFixed(8)) : undefined,
                trailingStopDistance: signal !== 'hold' ? Number(trailingStopDistance?.toFixed(8)) : undefined,
                positionSizeMultiplier: signal !== 'hold' ? Number(positionSizeMultiplier?.toFixed(3)) : undefined,
                mlConfidence: this.mlService.isReady() ? mlConfidence : undefined,
                features,
            };
        } catch (err) {
            logger.error(`Error generating signal for ${symbol}`, { err });
            reasons.push(`Exception: ${(err as Error).message}`);
            return { symbol, signal: 'hold', confidence: 0, reason: reasons, features: [] };
        }
    }
}
