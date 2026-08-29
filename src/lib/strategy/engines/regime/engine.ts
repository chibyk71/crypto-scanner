// src/lib/strategy/engines/regime/engine.ts
// Experimental regime strategy engine (treatment).
//
// Pipeline:
//   market data → indicators → regime → setup → quality → TradeSignal
//
// Does NOT import or call legacy scoring modules (computeScores, determineSignal).
// Risk params reuse existing computeRiskParams when a setup is accepted
// (shared infrastructure; not regime-specific sizing/exits).

import type { TradeSignal } from '../../../../types';
import { computeIndicators } from '../../../utils/indicatorUtils';
import { createLogger } from '../../../logger';
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
    regime: RegimeClassification['regime']
): TradeSignal {
    return buildFinalSignal({
        symbol,
        signal: 'hold',
        confidence: 0,
        reasons,
        features: [],
        regime,
    });
}

/**
 * Run the experimental regime engine on a candidate.
 *
 * Isolation: never calls computeScores or determineSignal.
 */
export function runRegimeEngine(
    input: StrategyInput
): RegimeEngineEvaluation {
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

    const setup: SetupResult = detectSetupForRegime(classification);
    reasons.push(...setup.reasons);

    const quality = applyQualityFilter(setup);
    reasons.push(...quality.reasons);

    if (!quality.accepted || setup.side === null) {
        const signal = holdSignal(symbol, reasons, classification.regime);
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

    // Shared risk infrastructure (not redesigned for regimes).
    const risk = computeRiskParams(
        setup.side,
        price,
        atrMultiplier,
        riskRewardTarget,
        50, // fixed baseline confidence — not legacy score-derived
        indicators.last.atr,
        trendAndVolume.trendBias,
        1000,
        input.requireAtrFeasibility ?? true
    );

    if (!risk.feasible) {
        reasons.push(
            `regime engine: risk infeasible — ${risk.infeasibleReason ?? 'unknown'}`
        );
        const signal = holdSignal(symbol, reasons, classification.regime);
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
        confidence: 50,
        reasons,
        features: [],
        stopLoss: risk.stopLoss,
        takeProfit: risk.takeProfit,
        trailingStopDistance: risk.trailingStopDistance,
        positionSizeMultiplier: risk.positionSizeMultiplier,
        tplevels: risk.takeProfitLevels,
        regime: classification.regime,
    });

    const enriched: TradeSignal = {
        ...signal,
        engine: 'regime',
        setupId: setup.setupId,
    } as TradeSignal;

    logger.info(
        `Regime engine ${setup.side.toUpperCase()} ${symbol} setup=${setup.setupId}`,
        {
            regime: classification.regime,
            setupId: setup.setupId,
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
