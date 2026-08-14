import type {
    PartialTPLevel,
    TradeSignal,
} from '../../types';

import type { MLService } from '../services/mlService';
import type { ExchangeService } from '../services/exchange';

import { config } from '../config/settings';
import { createLogger } from '../logger';

import { computeIndicators } from '../utils/indicatorUtils';

import type { StrategyInput } from './types';

import {
    MIN_BB_BANDWIDTH_PCT,
} from './constants';

import {
    analyzeTrendAndVolume,
} from './market/trendVolumeAnalysis';

import {
    computeScores,
} from './scoring/computeScores';

import {
    determineSignal,
} from './signal/determineSignal';

import {
    isRiskEligible,
} from './risk/riskEligibility';

import {
    computeRiskParams,
} from './risk/riskParams';

import {
    buildFinalSignal,
} from './buildSignal';

const logger = createLogger('Strategy');

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
    private exchangeService: ExchangeService;

    // State
    public lastAtr: number = 0;                               // Latest ATR (exposed for debugging)

    /**
     * Constructor
     * @param mlService - Machine learning service for prediction bonus
     * @param cooldownMinutes - Minimum minutes between signals per symbol
     */
    constructor(
        mlService: MLService,
        exchangeService: ExchangeService
    ) {
        this.mlService = mlService;
        this.exchangeService = exchangeService;
    }

    /**
     * Main entry point for generating a technical trading signal.
     *
     * IMPORTANT:
     * This method intentionally preserves the execution order from the
     * original Strategy.generateSignal() implementation.
     *
     * The extracted helpers receive exactly the values that the former private
     * methods received through `this`.
     *
     * Key pipeline:
     *
     *   1. Compute indicators
     *   2. Analyze trend and volume
     *   3. Reject flat markets
     *   4. Compute technical + ML scores
     *   5. Check risk eligibility
     *   6. Determine final signal direction
     *   7. Calculate base risk levels
     *   8. Log the result
     *   9. Build the final TradeSignal
     */
    public async generateSignal(
        input: StrategyInput
    ): Promise<TradeSignal> {
        const reasons: string[] = [];

        const {
            symbol,
            primaryData,
            htfData,
            price,
            atrMultiplier,
            riskRewardTarget,
        } = input;

        try {
            // === 1. Compute all centralized indicators (EMA, VWMA, MACD, RSI, etc.) ===
            // This is the foundation for all scoring.
            const indicators = computeIndicators(
                primaryData,
                htfData
            );

            this.lastAtr = indicators.last.atr; // Exposed for debugging/monitoring

            // === 2. Early trend + volume analysis ===
            // If no clear trending market (ADX + DI dominance), we immediately hold.
            // This prevents signals in choppy/range-bound conditions.
            const trendAndVolume = analyzeTrendAndVolume(
                primaryData,
                indicators,
                price
            );

            if (!trendAndVolume.isTrending) {
                reasons.push(
                    'No trending market (weak ADX/DI) – holding'
                );

                return buildFinalSignal({
                    symbol,
                    signal: 'hold',
                    confidence: 0,
                    reasons,
                    features: [],
                    stopLoss: undefined,
                    takeProfit: undefined,
                    trailingStopDistance: undefined,
                    positionSizeMultiplier: undefined,
                    mlConfidence: this.mlService.isReady()
                        ? 0
                        : undefined,
                });
            }

            // === 3. Flat market filter (Bollinger Bandwidth) ===
            // Avoid signals in extremely low-volatility/squeezed markets.
            if (
                indicators.last.bbBandwidth <
                MIN_BB_BANDWIDTH_PCT
            ) {
                reasons.push(
                    `Flat market: BB Bandwidth ${indicators.last.bbBandwidth.toFixed(2)}% < ${MIN_BB_BANDWIDTH_PCT * 100}%`
                );

                return buildFinalSignal({
                    symbol,
                    signal: 'hold',
                    confidence: 0,
                    reasons,
                    features: [],
                    stopLoss: undefined,
                    takeProfit: undefined,
                    trailingStopDistance: undefined,
                    positionSizeMultiplier: undefined,
                    mlConfidence: this.mlService.isReady()
                        ? 0
                        : undefined,
                });
            }

            // === 4. Technical scoring + ML prediction ===
            // This returns buy/sell scores, feature vector, and ML confidence bonus.
            const scoringResult = await computeScores(
                indicators,
                trendAndVolume,
                input,
                reasons,
                this.mlService,
                this.exchangeService
            );

            const buyScore = scoringResult.buyScore;
            const sellScore = scoringResult.sellScore;
            const features = scoringResult.features;
            const mlConfidence = scoringResult.mlConfidence; // 0-1 probability from ML model

            // === 5. Risk eligibility check ===
            // Ensures ATR/volatility is in a sane range for scalping (not too quiet or explosive).
            const riskEligible = isRiskEligible(
                price,
                indicators.last.atr
            );

            // === 6. Final signal decision (pure technical + ML) ===
            // Uses the scored points, trend bias, and risk eligibility.
            // No excursion influence here — this is the raw signal.
            const decision = determineSignal(
                buyScore,
                sellScore,
                trendAndVolume.trendBias,
                riskEligible,
                reasons // reasons may be appended here (e.g., counter-trend penalty)
            );

            let finalSignal = decision.signal; // 'buy' | 'sell' | 'hold' — may be demoted below
            const finalConfidence = decision.confidence; // Normalized 0-100%

            // Add a clear reason summarizing the raw score direction
            reasons.push(
                `Raw technical direction: ${finalSignal.toUpperCase()} ` +
                `(buy score ${buyScore.toFixed(0)}, sell score ${sellScore.toFixed(0)})`
            );

            // === 7. Compute BASE risk parameters (unadjusted SL/TP) ===
            // We ONLY compute these if we have a valid buy/sell signal.
            // These base levels will be used for:
            //   • Simulation (always realistic exits)
            //   • AutoTradeService (starting point for any regime-based adjustments)
            let stopLoss: number | undefined = undefined;
            let takeProfit: number | undefined = undefined;
            let trailingStopDistance: number | undefined = undefined;
            let positionSizeMultiplier: number | undefined = undefined;
            let tplevels: PartialTPLevel[] = [];

            if (finalSignal !== 'hold') {
                const baseRiskParams = computeRiskParams(
                    finalSignal,
                    price,
                    atrMultiplier,
                    riskRewardTarget,
                    finalConfidence,
                    indicators.last.atr,
                    trendAndVolume.trendBias,
                    1000,
                    input.requireAtrFeasibility ?? true
                );

                if (!baseRiskParams.feasible) {
                    // Demote to hold — a signal with no valid risk levels must not
                    // be forwarded as buy/sell (previously this silently zeroed
                    // SL/TP while keeping the signal direction — a latent bug).
                    finalSignal = 'hold';

                    reasons.push(
                        `Signal demoted to HOLD: ${baseRiskParams.infeasibleReason ?? 'risk params infeasible'}`
                    );
                } else {
                    stopLoss = baseRiskParams.stopLoss;
                    takeProfit = baseRiskParams.takeProfit;
                    trailingStopDistance =
                        baseRiskParams.trailingStopDistance;
                    positionSizeMultiplier =
                        baseRiskParams.positionSizeMultiplier;
                    tplevels =
                        baseRiskParams.takeProfitLevels;

                    reasons.push(
                        `Base risk levels: SL $${stopLoss!.toFixed(6)}, TP $${takeProfit!.toFixed(6)} ` +
                        `(≈${(Math.abs(takeProfit! - price) / Math.abs(price - stopLoss!)).toFixed(2)}R, ` +
                        `target ${config.strategy.targetProfitPct}%)`
                    );
                }
            }

            // === 8. Logging (technical-only for clarity) ===
            logger.info(
                `Signal: ${finalSignal.toUpperCase()} ${symbol} @ ${price.toFixed(8)}`,
                {
                    confidence: finalConfidence.toFixed(2),
                    buyScore: buyScore.toFixed(1),
                    sellScore: sellScore.toFixed(1),
                    mlConfidence: this.mlService.isReady()
                        ? mlConfidence.toFixed(3)
                        : 'N/A',
                    willTradeOrAlert:
                        finalSignal !== 'hold'
                            ? 'forwarded to AutoTradeService'
                            : 'hold (no action)',
                }
            );

            // === 9. Return the pure technical TradeSignal ===
            // SL/TP are base (unadjusted) — AutoTradeService may modify them later.
            return buildFinalSignal({
                symbol,
                signal: finalSignal,
                confidence: finalConfidence,
                reasons,
                features,
                stopLoss,
                takeProfit,
                trailingStopDistance,
                positionSizeMultiplier,
                mlConfidence: this.mlService.isReady()
                    ? mlConfidence
                    : undefined,
                mlPredictedLabel:
                    scoringResult.mlPredictedLabel,
                tplevels,
            });
        } catch (error) {
            logger.error(
                `Error generating signal for ${symbol}`,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                }
            );

            reasons.push(
                `Signal generation error: ${error instanceof Error
                    ? error.message
                    : String(error)
                }`
            );

            return buildFinalSignal({
                symbol,
                signal: 'hold',
                confidence: 0,
                reasons,
                features: [],
                stopLoss: undefined,
                takeProfit: undefined,
                trailingStopDistance: undefined,
                positionSizeMultiplier: undefined,
                mlConfidence: this.mlService.isReady()
                    ? 0
                    : undefined,
            });
        }
    }
}
