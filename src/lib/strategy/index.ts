import type {
    PartialTPLevel,
    TradeSignal,
} from '../../types';
import { config } from '../config/settings';
import { createLogger } from '../logger';
import type { ExchangeService } from '../services/exchange';
import type { MLService } from '../services/mlService';
import { computeIndicators } from '../utils/indicatorUtils';


import {
    buildFinalSignal,
} from './buildSignal';
import {
    MIN_BB_BANDWIDTH_PCT,
} from './constants';
import { runRegimeEngine } from './engines/regime/engine';
import { resolveStrategyEngine } from './engines/selectEngine';
import {
    analyzeTrendAndVolume,
} from './market/trendVolumeAnalysis';
import {
    classifyRegime,
} from './regime/classifyRegime';
import {
    isRiskEligible,
} from './risk/riskEligibility';
import {
    computeRiskParams,
} from './risk/riskParams';
import {
    computeScores,
} from './scoring/computeScores';
import {
    determineSignal,
} from './signal/determineSignal';
import type { StrategyInput } from './types';

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
 *   • Read-only market regime instrumentation (Phase 2 shadow mode)
 *
 * Phase 2B: STRATEGY_ENGINE=legacy|regime selects the experimental regime
 * engine at a single boundary before any scoring. Default is legacy.
 */
export class Strategy {
    // External dependencies
    private mlService: MLService;
    private exchangeService: ExchangeService;

    // State
    public lastAtr: number = 0; // Latest ATR (exposed for debugging)

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
     * Default path (STRATEGY_ENGINE unset or legacy) is the frozen control.
     * Regime classification on the legacy path is instrumentation only.
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
            // Phase 2B: single engine boundary — default legacy (body below unchanged).
            if (resolveStrategyEngine(process.env.STRATEGY_ENGINE) === 'regime') {
                return (await runRegimeEngine(input, this.mlService)).signal;
            }

            // === 1. Compute all centralized indicators ===
            const indicators = computeIndicators(
                primaryData,
                htfData
            );

            this.lastAtr = indicators.last.atr;

            // === 2. Early trend + volume analysis ===
            const trendAndVolume = analyzeTrendAndVolume(
                primaryData,
                indicators,
                price
            );

            // === 2.5. Market regime classification (READ ONLY) ===
            // Phase 2: three-regime engine (TREND / RANGE / BREAKOUT).
            // Shadow mode — regime is instrumentation only; does not affect
            // scoring, signal, confidence, ML, risk, or eligibility.
            const regimeClassification = classifyRegime(
                indicators,
                price,
                trendAndVolume.trendBias,
                {
                    closes: primaryData.closes,
                    volumes: primaryData.volumes,
                    hasVolumeSurge: trendAndVolume.hasVolumeSurge,
                }
            );

            // === 3. Reject non-trending markets ===
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
                    regime: regimeClassification.regime,
                });
            }

            // === 4. Flat market filter (Bollinger Bandwidth) ===
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
                    regime: regimeClassification.regime,
                });
            }

            // === 5. Technical scoring + ML prediction ===
            // Regime is intentionally NOT passed here.
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
            const mlConfidence = scoringResult.mlConfidence;

            // === 6. Risk eligibility check ===
            const riskEligible = isRiskEligible(
                price,
                indicators.last.atr
            );

            // === 7. Final signal decision ===
            // Regime is intentionally NOT used here.
            const decision = determineSignal(
                buyScore,
                sellScore,
                trendAndVolume.trendBias,
                riskEligible,
                reasons
            );

            let finalSignal = decision.signal;
            const finalConfidence = decision.confidence;

            reasons.push(
                `Raw technical direction: ${finalSignal.toUpperCase()} ` +
                `(buy score ${buyScore.toFixed(0)}, sell score ${sellScore.toFixed(0)})`
            );

            // === 8. Compute BASE risk parameters ===
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

            // === 9. Logging ===
            logger.info(
                `Signal: ${finalSignal.toUpperCase()} ${symbol} @ ${price.toFixed(8)}`,
                {
                    confidence: finalConfidence.toFixed(2),
                    buyScore: buyScore.toFixed(1),
                    sellScore: sellScore.toFixed(1),

                    // Read-only regime instrumentation
                    regime: regimeClassification.regime,
                    regimeAdx:
                        regimeClassification.adx.toFixed(2),
                    regimeBbBandwidth:
                        regimeClassification.bbBandwidth.toFixed(4),
                    regimeAtrPct:
                        regimeClassification.atrPct.toFixed(4),
                    regimeBreakout:
                        regimeClassification.isBreakout,
                    regimeTrendEvidence:
                        regimeClassification.isTrendEvidence,

                    mlConfidence: this.mlService.isReady()
                        ? mlConfidence.toFixed(3)
                        : 'N/A',

                    willTradeOrAlert:
                        finalSignal !== 'hold'
                            ? 'forwarded to AutoTradeService'
                            : 'hold (no action)',
                }
            );

            // === 10. Return the final TradeSignal ===
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

                // Attached for instrumentation only.
                regime: regimeClassification.regime,
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

            // No regime is attached here because an error may have occurred
            // before indicators/trend analysis/regime classification completed.
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
