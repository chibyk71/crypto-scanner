import type { SignalLabel } from '../../../types';

import type { ExchangeService } from '../../services/exchange';
import type { MLService } from '../../services/mlService';

import { createLogger } from '../../logger';

import type { IndicatorMap } from '../../utils/indicatorUtils';

import type {
    ScoresAndML,
    StrategyInput,
    TrendAndVolume,
} from '../types';

import {
    ADX_POINTS,
    AMBIGUOUS_CONFIDENCE_MAX,
    AMBIGUOUS_CONFIDENCE_MIN,
    BB_SQUEEZE_BREAKOUT_POINTS,
    CONFIDENCE_THRESHOLD,
    DIRECTIONAL_TIEBREAK_MAX,
    EMA_ALIGNMENT_POINTS,
    ENGULFING_POINTS,
    LIQUIDITY_SWEEP_POINTS,
    MACD_POINTS,
    MACD_ZERO_POINTS,
    MAX_ATR_PCT,
    MIN_ADX,
    MIN_ATR_PCT,
    ML_BONUS_MAX,
    ML_CONFIDENCE_DISCOUNT,
    MOMENTUM_IGNITION_DECAY,
    OBV_VWMA_POINTS,
    ORDER_BOOK_GATE_MARGIN,
    ORDER_BOOK_IMBALANCE_POINTS,
    ORDER_BOOK_IMBALANCE_THRESHOLD,
    PERCENT_B_COMBO_POINTS,
    PERCENT_B_POINTS,
    RSI_POINTS,
    SCORE_MARGIN_REQUIRED,
    STOCH_POINTS,
    VWAP_DEVIATION_ATR_THRESHOLD,
    VWAP_REVERSION_POINTS,
    VWMA_SLOPE_POINTS,
    VWMA_VWAP_POINTS,
} from '../constants';

import {
    detectBbSqueezeBreakout,
} from '../patterns/bbSqueezeBreakout';

import {
    findRecentIgnitionTrigger,
} from '../patterns/momentumIgnition';

const logger = createLogger('Strategy');

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
 *   • Evidence is accumulated into four named buckets (trend / momentum /
 *     volume / entry) then summed once before ML. This is instrumentation
 *     only — no regime weighting is applied here.
 *
 * @param indicators - Centralized indicator results
 * @param trendAndVolume - Market regime from analyzeTrendAndVolume
 * @param input - Strategy parameters and price
 * @param reasons - Mutable array filled with human-readable explanations
 * @returns Scores, ML features, and confidence for final decision
 */
export async function computeScores(
    indicators: IndicatorMap,
    trendAndVolume: TrendAndVolume,
    input: StrategyInput,
    reasons: string[],
    mlService: MLService,
    exchangeService: ExchangeService
): Promise<ScoresAndML> {
    // Evidence buckets — all technical points land here first.
    // buyScore / sellScore are materialised from these immediately before ML.
    let trendBuy = 0;
    let trendSell = 0;
    let momentumBuy = 0;
    let momentumSell = 0;
    let volumeBuy = 0;
    let volumeSell = 0;
    let entryBuy = 0;
    let entrySell = 0;

    // -------------------- EMA ALIGNMENT --------------------
    // bucket: trend
    if (
        input.price > indicators.last.emaShort &&
        indicators.last.emaShort > indicators.last.htfEmaMid
    ) {
        trendBuy += EMA_ALIGNMENT_POINTS;
        reasons.push('Bullish EMA alignment: Price > EMA20 > HTF EMA50');
    } else if (
        input.price < indicators.last.emaShort &&
        indicators.last.emaShort < indicators.last.htfEmaMid
    ) {
        trendSell += EMA_ALIGNMENT_POINTS;
        reasons.push('Bearish EMA alignment: Price < EMA20 < HTF EMA50');
    }

    // -------------------- VWMA vs VWAP --------------------
    // bucket: trend
    if (indicators.last.vwma > indicators.last.vwap) {
        trendBuy += VWMA_VWAP_POINTS;
        reasons.push('Bullish VWMA > VWAP');
    } else if (indicators.last.vwma < indicators.last.vwap) {
        trendSell += VWMA_VWAP_POINTS;
        reasons.push('Bearish VWMA < VWAP');
    }

    // -------------------- MACD (tiered scoring) --------------------
    // bucket: trend
    // Safe conversion – some indicator libs may return undefined
    const macdVal = Number(indicators.last.macdLine ?? 0);
    const macdSignalVal = Number(indicators.last.macdSignal ?? 0);
    const macdHistVal = Number(indicators.last.macdHistogram ?? 0);

    if (macdVal && macdHistVal && macdSignalVal) {
        const macdCrossUp = macdVal > macdSignalVal;
        const histPositive = macdHistVal > 0;

        if (macdCrossUp && histPositive) {
            trendBuy += MACD_POINTS;
            reasons.push('Strong Bullish MACD: Crossover + Positive Histogram');
        } else if (macdCrossUp) {
            trendBuy += MACD_POINTS / 2;
            reasons.push('Weak Bullish MACD: Crossover but Histogram not positive');
        }

        const macdCrossDown = macdVal < macdSignalVal;
        const histNegative = macdHistVal < 0;

        if (macdCrossDown && histNegative) {
            trendSell += MACD_POINTS;
            reasons.push('Strong Bearish MACD: Crossover + Negative Histogram');
        } else if (macdCrossDown) {
            trendSell += MACD_POINTS / 2;
            reasons.push('Weak Bearish MACD: Crossover but Histogram not negative');
        }
    }

    // -------------------- MACD ZERO-LINE TREND STRENGTH --------------------
    // bucket: trend
    if (macdVal > 0) {
        trendBuy += MACD_ZERO_POINTS;
        reasons.push('Bullish MACD above zero line');
    } else if (macdVal < 0) {
        trendSell += MACD_ZERO_POINTS;
        reasons.push('Bearish MACD below zero line');
    }

    // -------------------- RSI --------------------
    // bucket: momentum
    const rsi = indicators.last.rsi;

    if (rsi < 30) {
        momentumBuy += RSI_POINTS;
        reasons.push(`RSI oversold: ${rsi.toFixed(1)}`);
    } else if (rsi > 70) {
        momentumSell += RSI_POINTS;
        reasons.push(`RSI overbought: ${rsi.toFixed(1)}`);
    }

    // -------------------- STOCHASTIC --------------------
    // bucket: momentum
    const stochK = indicators.last.stochasticK;
    const stochD = indicators.last.stochasticD;

    if (stochK < 20 && stochK > stochD) {
        momentumBuy += STOCH_POINTS;
        reasons.push('Bullish Stochastic reversal from oversold');
    } else if (stochK > 80 && stochK < stochD) {
        momentumSell += STOCH_POINTS;
        reasons.push('Bearish Stochastic reversal from overbought');
    }

    // -------------------- OBV + VWMA MOMENTUM --------------------
    // bucket: momentum
    const obvRising =
        indicators.last.obv >
        (
            indicators.obv[indicators.obv.length - 2] ??
            indicators.last.obv
        );

    if (obvRising && input.price > indicators.last.vwma) {
        momentumBuy += OBV_VWMA_POINTS;
        reasons.push('Bullish OBV rising with price above VWMA (momentum)');
    } else if (!obvRising && input.price < indicators.last.vwma) {
        momentumSell += OBV_VWMA_POINTS;
        reasons.push('Bearish OBV falling with price below VWMA (momentum)');
    }

    // -------------------- LIQUIDITY SWEEP --------------------
    // bucket: entry
    const lastLiquiditySweep =
        trendAndVolume.liquiditySweep[
        trendAndVolume.liquiditySweep.length - 1
        ];

    if (lastLiquiditySweep === 'bullish') {
        entryBuy += LIQUIDITY_SWEEP_POINTS;
        reasons.push('Bullish liquidity sweep: swept low then reclaimed');
    } else if (lastLiquiditySweep === 'bearish') {
        entrySell += LIQUIDITY_SWEEP_POINTS;
        reasons.push('Bearish liquidity sweep: swept high then rejected');
    }

    // -------------------- VWAP MEAN-REVERSION --------------------
    // bucket: momentum
    // Additive to the vwma>vwap trend-following logic above, not a replacement.
    // When price has stretched far from VWAP (in ATR terms) AND momentum/OBV
    // isn't confirming continuation in that direction, bet on reversion back to VWAP.
    if (indicators.last.vwap > 0 && indicators.last.atr > 0) {
        const vwapDeviationAtr =
            (input.price - indicators.last.vwap) /
            indicators.last.atr;

        const momentum = indicators.last.momentum ?? 0;

        if (vwapDeviationAtr > VWAP_DEVIATION_ATR_THRESHOLD) {
            // Price stretched ABOVE VWAP — continuation would need positive momentum + rising OBV.
            // Either missing → no confirmation → bet on reversion down.
            const continuationConfirmed =
                momentum > 0 && obvRising;

            if (!continuationConfirmed) {
                momentumSell += VWAP_REVERSION_POINTS;

                reasons.push(
                    `VWAP mean-reversion: price ${vwapDeviationAtr.toFixed(2)}x ATR above VWAP, ` +
                    `continuation unconfirmed (momentum=${momentum.toFixed(4)}, obvRising=${obvRising})`
                );
            }
        } else if (
            vwapDeviationAtr <
            -VWAP_DEVIATION_ATR_THRESHOLD
        ) {
            // Price stretched BELOW VWAP — continuation would need negative momentum + falling OBV.
            // Either missing → no confirmation → bet on reversion up.
            const continuationConfirmed =
                momentum < 0 && !obvRising;

            if (!continuationConfirmed) {
                momentumBuy += VWAP_REVERSION_POINTS;

                reasons.push(
                    `VWAP mean-reversion: price ${Math.abs(vwapDeviationAtr).toFixed(2)}x ATR below VWAP, ` +
                    `continuation unconfirmed (momentum=${momentum.toFixed(4)}, obvRising=${obvRising})`
                );
            }
        }
    }

    // -------------------- ATR VOLATILITY RANGE --------------------
    // Not assigned to a bucket — does not add to any score (reasons only).
    const atrPct =
        (indicators.last.atr / input.price) * 100;

    logger.info(
        `ATR Analysis for ${input.symbol}: ATR=${indicators.last.atr.toFixed(4)}, Price=${input.price.toFixed(4)}, ATR%=${atrPct.toFixed(2)}%`
    );

    /**
     * ATR measures market volatility, not trade direction.
     *
     * Do not add points to both buy and sell scores here. Adding equal
     * points inflates overall confidence without providing directional
     * evidence and can push weak setups closer to the signal threshold.
     *
     * ATR eligibility/risk handling remains available elsewhere in the
     * strategy; this block only records that volatility is in range.
     */
    if (
        atrPct > MIN_ATR_PCT &&
        atrPct < MAX_ATR_PCT
    ) {
        reasons.unshift(
            `Sane ATR volatility: ${atrPct.toFixed(2)}%`
        );
    }

    // -------------------- VWMA SLOPE --------------------
    // bucket: trend
    if (!trendAndVolume.vwmaFalling) {
        trendBuy += VWMA_SLOPE_POINTS;
        reasons.push('Bullish VWMA slope');
    } else {
        trendSell += VWMA_SLOPE_POINTS;
        reasons.push('Bearish VWMA slope');
    }

    // -------------------- ADX TREND STRENGTH --------------------
    // bucket: trend
    if (trendAndVolume.isTrending) {
        if (trendAndVolume.trendBias === 'bullish') {
            trendBuy += ADX_POINTS;
        } else if (trendAndVolume.trendBias === 'bearish') {
            trendSell += ADX_POINTS;
        }

        reasons.unshift(
            `Strong trend confirmed by ADX >${MIN_ADX}`
        );
    }

    // -------------------- ENGULFING PATTERN --------------------
    // bucket: entry
    // Recency-gated: full points only if the volume-confirmed engulfing candle
    // "just ignited" (within MOMENTUM_IGNITION_LOOKBACK candles). Decays with age
    // so a pattern that already moved 1-2 candles ago doesn't get treated the
    // same as one firing right now.
    const ignitionTrigger =
        findRecentIgnitionTrigger(
            input.primaryData,
            trendAndVolume.engulfing
        );

    const lastPattern =
        trendAndVolume.engulfing[
        trendAndVolume.engulfing.length - 1
        ]; // still used by BB combo below

    if (ignitionTrigger) {
        const decay =
            MOMENTUM_IGNITION_DECAY[
            ignitionTrigger.offset
            ] ?? 0;

        const pts =
            ENGULFING_POINTS * decay;

        const ageLabel =
            ignitionTrigger.offset === 0
                ? 'this candle'
                : `${ignitionTrigger.offset} candle${ignitionTrigger.offset === 1 ? '' : 's'} ago`;

        if (ignitionTrigger.type === 'bullish') {
            entryBuy += pts;

            reasons.push(
                `Bullish Engulfing + volume surge ignited ${ageLabel} → ${pts.toFixed(1)}pts (${(decay * 100).toFixed(0)}%)`
            );
        } else {
            entrySell += pts;

            reasons.push(
                `Bearish Engulfing + volume surge ignited ${ageLabel} → ${pts.toFixed(1)}pts (${(decay * 100).toFixed(0)}%)`
            );
        }
    }

    // -------------------- PERCENT_B POSITION --------------------
    // bucket: entry
    const percentB =
        indicators.last.percentB ?? 0.5;

    if (percentB < 0.4) {
        // Price in lower third of BB — good entry zone for buys
        entryBuy += PERCENT_B_POINTS;
        entrySell -= PERCENT_B_POINTS;  // penalty: selling at a low is risky

        reasons.push(
            `Bullish BB position: percent_b=${percentB.toFixed(3)} (lower zone)`
        );
    } else if (percentB > 0.7) {
        // Price in upper third of BB — good entry zone for sells
        entrySell += PERCENT_B_POINTS;
        entryBuy -= PERCENT_B_POINTS;  // penalty: buying near the top is risky

        reasons.push(
            `Bearish BB position: percent_b=${percentB.toFixed(3)} (upper zone)`
        );
    }
    // percent_b 0.4–0.7 is neutral — no points awarded either way

    // -------------------- PERCENT_B + ENGULFING COMBO BONUS --------------------
    // bucket: entry
    // 22% of good trades had both percent_b < 0.5 AND an engulfing signal
    // vs only 14% of bad trades — a meaningful combination worth a small bonus.
    if (
        lastPattern === 'bullish' &&
        percentB < 0.5
    ) {
        entryBuy += PERCENT_B_COMBO_POINTS;
        reasons.push(
            `BB+Engulfing combo: bullish engulfing in lower BB half`
        );
    } else if (
        lastPattern === 'bearish' &&
        percentB > 0.5
    ) {
        entrySell += PERCENT_B_COMBO_POINTS;
        reasons.push(
            `BB+Engulfing combo: bearish engulfing in upper BB half`
        );
    }

    // -------------------- BB SQUEEZE → BREAKOUT --------------------
    // bucket: entry
    const squeezeBreakout =
        detectBbSqueezeBreakout(
            indicators,
            input.primaryData.closes
        );

    if (squeezeBreakout === 'bullish') {
        entryBuy += BB_SQUEEZE_BREAKOUT_POINTS;

        reasons.push(
            `Bullish BB squeeze breakout: bandwidth expanded from squeeze, close broke above prior upper band`
        );
    } else if (squeezeBreakout === 'bearish') {
        entrySell += BB_SQUEEZE_BREAKOUT_POINTS;

        reasons.push(
            `Bearish BB squeeze breakout: bandwidth expanded from squeeze, close broke below prior lower band`
        );
    }

    // -------------------- ORDER BOOK IMBALANCE (gated, lazy fetch) --------------------
    // bucket: volume
    // Only fetch the order book when the leading side is already close to
    // CONFIDENCE_THRESHOLD — avoids a REST call for symbols nowhere near a signal.
    // Cached with a short TTL in ExchangeService so repeated calls within the same
    // scan cycle (e.g. AutoTradeService re-checking) don't refetch.
    //
    // Gate uses the sum of all buckets accumulated so far (volume is still 0 here),
    // matching the pre-bucket behaviour of Math.max(buyScore, sellScore).
    const buyScoreSoFar =
        trendBuy + momentumBuy + volumeBuy + entryBuy;
    const sellScoreSoFar =
        trendSell + momentumSell + volumeSell + entrySell;
    const leadingScore =
        Math.max(buyScoreSoFar, sellScoreSoFar);

    if (
        leadingScore >=
        CONFIDENCE_THRESHOLD - ORDER_BOOK_GATE_MARGIN
    ) {
        try {
            const book =
                await exchangeService.getOrderBookImbalance(
                    input.symbol
                );

            if (
                book &&
                Math.abs(book.imbalance) >=
                ORDER_BOOK_IMBALANCE_THRESHOLD
            ) {
                // Scale points linearly between threshold and 1.0 imbalance
                const magnitude =
                    Math.min(
                        1,
                        Math.abs(book.imbalance)
                    );

                const scaledPts =
                    ORDER_BOOK_IMBALANCE_POINTS *
                    (
                        (magnitude - ORDER_BOOK_IMBALANCE_THRESHOLD) /
                        (1 - ORDER_BOOK_IMBALANCE_THRESHOLD)
                    );

                if (book.imbalance > 0) {
                    volumeBuy += scaledPts;

                    reasons.push(
                        `Order book bid-heavy: imbalance ${book.imbalance.toFixed(3)} → +${scaledPts.toFixed(1)}pts`
                    );
                } else {
                    volumeSell += scaledPts;

                    reasons.push(
                        `Order book ask-heavy: imbalance ${book.imbalance.toFixed(3)} → +${scaledPts.toFixed(1)}pts`
                    );
                }
            } else if (book) {
                reasons.push(
                    `Order book balanced (imbalance ${book.imbalance.toFixed(3)}) → no bonus`
                );
            }
        } catch (err) {
            logger.warn(
                `Order book fetch failed during scoring for ${input.symbol}`,
                {
                    error:
                        err instanceof Error
                            ? err.message
                            : String(err),
                }
            );

            // Fail-open: no points, no crash — order book is a bonus signal, not a gate
        }
    }

    // =========================================================================
    // MATERIALISE TOTALS FROM BUCKETS (pre-ML)
    // =========================================================================
    // Sum buckets into buyScore / sellScore exactly as the unbucketed code would
    // have accumulated them. Everything from the ML block onward is unchanged.
    let buyScore =
        trendBuy + momentumBuy + volumeBuy + entryBuy;
    let sellScore =
        trendSell + momentumSell + volumeSell + entrySell;

    // Snapshot of pure technical evidence (before ML bonus/penalty or tie-break).
    // Instrumentation only — nothing downstream currently reads this field.
    const bucketBreakdown = {
        trend: { buy: trendBuy, sell: trendSell },
        momentum: { buy: momentumBuy, sell: momentumSell },
        volume: { buy: volumeBuy, sell: volumeSell },
        entry: { buy: entryBuy, sell: entrySell },
    };

    // -------------------- ML PREDICTION INTEGRATION --------------------
    const features =
        await mlService.extractFeatures(input, {
            liquiditySweep: lastLiquiditySweep,
            bbSqueezeBreakout: squeezeBreakout, // already computed above, in the BB squeeze scoring block
        });

    const preMlBuyScore = buyScore;
    const preMlSellScore = sellScore;

    let mlWinConfidence = 0;
    let mlLossConfidence = 0;
    let predictedLabel: SignalLabel = 0;

    if (mlService.isReady()) {
        const prediction =
            await mlService.predict(features);

        predictedLabel = prediction.label;
        mlWinConfidence = prediction.confidence;
        mlLossConfidence = 1 - mlWinConfidence;

        if (predictedLabel >= 1) {
            const bonus =
                mlWinConfidence * ML_BONUS_MAX;

            /**
             * Combined ML predicts the quality of the CURRENT technical setup,
             * not an independent trade direction.
             *
             * A positive prediction therefore strengthens whichever side was
             * already leading before ML was applied.
             */
            if (preMlBuyScore > preMlSellScore) {
                buyScore += bonus;

                reasons.unshift(
                    `ML PREDICTS WIN for technical BUY leader (label ${predictedLabel}) ` +
                    `→ +${bonus.toFixed(0)}pts (${(mlWinConfidence * 100).toFixed(1)}%)`
                );
            } else if (preMlSellScore > preMlBuyScore) {
                sellScore += bonus;

                reasons.unshift(
                    `ML PREDICTS WIN for technical SELL leader (label ${predictedLabel}) ` +
                    `→ +${bonus.toFixed(0)}pts (${(mlWinConfidence * 100).toFixed(1)}%)`
                );
            } else {
                /**
                 * No technical leader exists, so the combined model must not
                 * manufacture a direction on its own.
                 */
                reasons.unshift(
                    `ML PREDICTS WIN (label ${predictedLabel}) but technical scores are tied → no bonus applied`
                );
            }
        } else if (predictedLabel <= -1) {
            const penalty =
                mlLossConfidence * ML_BONUS_MAX * 0.9;

            /**
             * A negative combined-model prediction means the current
             * technical setup is expected to perform poorly.
             *
             * IMPORTANT:
             * Do NOT award these points to the opposite side.
             * A bad BUY setup does not automatically prove SELL is good.
             *
             * Instead, penalize whichever side was the technical leader
             * before ML was applied.
             */
            if (preMlBuyScore > preMlSellScore) {
                buyScore =
                    Math.max(0, buyScore - penalty);

                reasons.unshift(
                    `ML PREDICTS LOSS for technical BUY leader (label ${predictedLabel}) ` +
                    `→ -${penalty.toFixed(0)}pts penalty (${(mlLossConfidence * 100).toFixed(1)}%)`
                );
            } else if (preMlSellScore > preMlBuyScore) {
                sellScore =
                    Math.max(0, sellScore - penalty);

                reasons.unshift(
                    `ML PREDICTS LOSS for technical SELL leader (label ${predictedLabel}) ` +
                    `→ -${penalty.toFixed(0)}pts penalty (${(mlLossConfidence * 100).toFixed(1)}%)`
                );
            } else {
                /**
                 * With no technical leader, there is nothing specific to
                 * penalize. The combined model must not create a direction.
                 */
                reasons.unshift(
                    `ML PREDICTS LOSS (label ${predictedLabel}) but technical scores are tied → no penalty applied`
                );
            }
        } else {
            reasons.push(
                `ML neutral (label 0) → no bonus`
            );
        }

        logger.debug('ML Prediction Applied', {
            symbol: input.symbol,
            predictedLabel,
            winConf:
                (mlWinConfidence * 100).toFixed(1) + '%',
            lossConf:
                (mlLossConfidence * 100).toFixed(1) + '%',
            buyScore: buyScore.toFixed(1),
            sellScore: sellScore.toFixed(1),
        });

        // ---------------- HYBRID TIE-BREAKER (dual buy/sell models) ----------------
        // Only engages when the COMBINED model's confidence is ambiguous — a strong
        // combined prediction is left alone. When ambiguous, defer to the side-specific
        // model matching the raw technical leader (pre-ML scores), if that side has
        // enough training data to be trusted.
        if (
            mlWinConfidence >= AMBIGUOUS_CONFIDENCE_MIN &&
            mlWinConfidence <= AMBIGUOUS_CONFIDENCE_MAX
        ) {
            const leaderSide: 'buy' | 'sell' | null =
                preMlBuyScore > preMlSellScore
                    ? 'buy'
                    : preMlSellScore > preMlBuyScore
                        ? 'sell'
                        : null;

            if (!leaderSide) {
                reasons.push(
                    'ML confidence ambiguous, no clear technical leader → tie-breaker skipped'
                );
            } else if (
                !mlService.isDirectionalReady(leaderSide)
            ) {
                reasons.push(
                    `ML confidence ambiguous (${(mlWinConfidence * 100).toFixed(1)}%) but ${leaderSide} model not ready → tie-breaker skipped`
                );
            } else {
                const dirResult =
                    await mlService.predictDirectional(
                        leaderSide,
                        features
                    );

                if (dirResult.label >= 1) {
                    const bonus =
                        dirResult.confidence *
                        DIRECTIONAL_TIEBREAK_MAX;

                    if (leaderSide === 'buy') {
                        buyScore += bonus;
                    } else {
                        sellScore += bonus;
                    }

                    reasons.push(
                        `Directional tie-break: ${leaderSide}-model confirms (label ${dirResult.label}) → +${bonus.toFixed(1)}pts`
                    );
                } else if (dirResult.label <= -1) {
                    const penalty =
                        dirResult.confidence *
                        DIRECTIONAL_TIEBREAK_MAX;

                    if (leaderSide === 'buy') {
                        buyScore =
                            Math.max(
                                0,
                                buyScore - penalty
                            );
                    } else {
                        sellScore =
                            Math.max(
                                0,
                                sellScore - penalty
                            );
                    }

                    reasons.push(
                        `Directional tie-break: ${leaderSide}-model predicts LOSS (label ${dirResult.label}) → -${penalty.toFixed(1)}pts penalty`
                    );
                } else {
                    reasons.push(
                        `Directional tie-break: ${leaderSide}-model neutral → no adjustment`
                    );
                }
            }
        }
    } else {
        reasons.push(
            'ML model not ready → no prediction bonus'
        );

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
    let potentialDirection:
        | 'long'
        | 'short'
        | null = null;

    const scoreMargin =
        SCORE_MARGIN_REQUIRED * 0.5;  // Relaxed margin for potential (pre-excursion)

    if (
        buyScore >= CONFIDENCE_THRESHOLD &&
        buyScore - sellScore >= scoreMargin
    ) {
        potentialDirection = 'long';
    } else if (
        sellScore >= CONFIDENCE_THRESHOLD &&
        sellScore - buyScore >= scoreMargin
    ) {
        potentialDirection = 'short';
    }

    if (potentialDirection) {
        reasons.push(
            `Pre-excursion potential direction: ${potentialDirection} (buy=${buyScore.toFixed(1)}, sell=${sellScore.toFixed(1)})`
        );
    } else {
        reasons.push(
            'No clear pre-excursion potential direction'
        );
    }

    return {
        buyScore,
        sellScore,
        features,
        mlConfidence: mlWinConfidence,
        potentialDirection,
        mlPredictedLabel:
            mlService.isReady()
                ? predictedLabel
                : undefined,
        bucketBreakdown,
    };
}
