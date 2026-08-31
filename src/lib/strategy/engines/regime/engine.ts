// src/lib/strategy/engines/regime/engine.ts
// Experimental regime strategy engine (treatment).
//
// Pipeline:
//   market data → indicators → regime → setup → quality → TradeSignal
//
// Does NOT import or call legacy scoring modules (computeScores, determineSignal).
//
// Risk: after quality acceptance, shared computeRiskParams is invoked using
// only StrategyInput fields and existing config — never invented confidence
// or account-balance literals at this call site.
//
// Features: extractFeatures is called once near the top (no liquiditySweep /
// bbSqueezeBreakout extras) so every path — hold or accepted — carries a full
// 33-length feature vector into simulateTrade. ML predict is intentionally
// NOT called on the decision path for the first live run (D.1).

import type { TradeSignal } from '../../../../types';
import { config } from '../../../config/settings';
import { createLogger } from '../../../logger';
import type { MLService } from '../../../services/mlService';
import { computeIndicators } from '../../../utils/indicatorUtils';
import { buildFinalSignal } from '../../buildSignal';
import { analyzeTrendAndVolume } from '../../market/trendVolumeAnalysis';
import { classifyRegime } from '../../regime/classifyRegime';
import type { RegimeClassification } from '../../regime/types';
import { computeRiskParams } from '../../risk/riskParams';
import type { StrategyInput } from '../../types';
import type { RegimeEngineEvaluation, SetupResult } from '../types';
import { applyQualityFilter } from './quality';
import { detectSetupForRegime } from './setups';

const logger = createLogger('RegimeEngine');

function holdSignal(
    symbol: string,
    reasons: string[],
    regime: RegimeClassification['regime'],
    features: number[]
): TradeSignal {
    return buildFinalSignal({
        symbol,
        signal: 'hold',
        confidence: 0,
        reasons,
        features,
        regime,
        engine: 'regime',
    });
}

/**
 * Run the experimental regime engine on a candidate.
 *
 * Isolation: never calls computeScores or determineSignal.
 * Features: always extracted (length 33) so simulateTrade can persist rows.
 * ML predict: intentionally not called — structural hypothesis only (D.1).
 */
export async function runRegimeEngine(
    input: StrategyInput,
    mlService: MLService
): Promise<RegimeEngineEvaluation> {
    const reasons: string[] = [];
    const { symbol, primaryData, htfData, price, atrMultiplier, riskRewardTarget } =
        input;

    const indicators = computeIndicators(primaryData, htfData);
    const trendAndVolume = analyzeTrendAndVolume(
        primaryData,
        indicators,
        price
    );

    const classification = classifyRegime(
        indicators,
        price,
        trendAndVolume.trendBias,
        {
            closes: primaryData.closes,
            volumes: primaryData.volumes,
            hasVolumeSurge: trendAndVolume.hasVolumeSurge,
        }
    );

    reasons.push(`regime engine: classified ${classification.regime}`);

    // Extract features once for all paths. No liquiditySweep/bbSqueezeBreakout
    // extras — those are legacy-scoring detector flags; leave neutral (0).
    const features = await mlService.extractFeatures(input);

    const setup: SetupResult = detectSetupForRegime({
        classification,
        indicators,
        price,
    });
    reasons.push(...setup.reasons);

    const quality = applyQualityFilter(setup);
    reasons.push(...quality.reasons);

    if (!quality.accepted || setup.side === null) {
        const signal = holdSignal(symbol, reasons, classification.regime, features);
        logger.info(`Regime engine HOLD ${symbol}`, {
            regime: classification.regime,
            setupId: setup.setupId,
            detected: setup.detected,
        });
        return {
            engine: 'regime',
            regime: classification.regime,
            setup,
            quality,
            signal: {
                ...signal,
                engine: 'regime',
                setupId: setup.setupId,
            } as TradeSignal,
        };
    }

    // Shared risk infrastructure (not redesigned; not regime-specific).
    // Confidence: configured gate value from settings — not a fabricated score.
    // Account balance: omitted so computeRiskParams uses its own documented
    // default (same unspecified-balance path as callers that omit the arg).
    // Fixed confidence is intentional for first live run (D.2).
    const signalConfidence = config.strategy.confidenceThreshold;

    const risk = computeRiskParams(
        setup.side,
        price,
        atrMultiplier,
        riskRewardTarget,
        signalConfidence,
        indicators.last.atr,
        trendAndVolume.trendBias,
        undefined,
        input.requireAtrFeasibility ?? true
    );

    if (!risk.feasible) {
        reasons.push(
            `regime engine: risk infeasible — ${risk.infeasibleReason ?? 'unknown'}`
        );
        const signal = holdSignal(symbol, reasons, classification.regime, features);
        return {
            engine: 'regime',
            regime: classification.regime,
            setup,
            quality: {
                accepted: false,
                reasons: [...quality.reasons, 'quality: demoted by risk feasibility'],
            },
            signal: {
                ...signal,
                engine: 'regime',
                setupId: setup.setupId,
            } as TradeSignal,
        };
    }

    const signal = buildFinalSignal({
        symbol,
        signal: setup.side,
        confidence: signalConfidence,
        reasons,
        features,
        stopLoss: risk.stopLoss,
        takeProfit: risk.takeProfit,
        trailingStopDistance: risk.trailingStopDistance,
        positionSizeMultiplier: risk.positionSizeMultiplier,
        tplevels: risk.takeProfitLevels,
        regime: classification.regime,
        engine: 'regime',
    });

    const enriched: TradeSignal = {
        ...signal,
        setupId: setup.setupId,
    } as TradeSignal;

    logger.info(
        `Regime engine ${setup.side.toUpperCase()} ${symbol} setup=${setup.setupId}`,
        {
            regime: classification.regime,
            setupId: setup.setupId,
            confidence: signalConfidence,
        }
    );

    return {
        engine: 'regime',
        regime: classification.regime,
        setup,
        quality,
        signal: enriched,
    };
}
