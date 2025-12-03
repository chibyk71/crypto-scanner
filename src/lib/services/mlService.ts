// src/lib/services/mlService.ts
// =============================================================================
// ML SERVICE – 5-TIER RANDOM FOREST CLASSIFIER (FULLY TYPE-SAFE + PRODUCTION READY)
// Integrated with simulateTrade.ts → uses real R-multiple outcomes
// Supports: -2 (disaster), -1 (loss), 0 (neutral), +1 (good), +2 (monster win)
// =============================================================================

import * as fs from 'fs/promises';
import { RandomForestClassifier } from 'ml-random-forest';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import { dbService } from '../db';
import type { StrategyInput, SignalLabel } from '../../types'; // ← Critical: from single source of truth
import {
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateStochastic,
    calculateATR,
    calculateOBV,
    calculateVWMA,
    calculateVWAP,
    calculateMomentum,
    detectEngulfing,
    calculateBollingerBands,
    calculateADX,
} from '../indicators';

/**
 * Logger instance for MLService operations.
 * - Tagged with 'MLService' for categorized logging.
 */
const logger = createLogger('MLService');

/**
 * MLService – The brain that learns from high-fidelity simulated outcomes
 * Uses 5-tier labeling (-2 to +2) based on R-multiple from simulateTrade.ts
 */
export class MLService {
    private classifier: RandomForestClassifier;
    private isModelLoaded = false;
    private isTrainingPaused = false;

    // All possible labels for multi-class prediction
    private readonly ALL_LABELS: SignalLabel[] = [-2, -1, 0, 1, 2];

    // Hyperparameters – balanced for crypto volatility
    private readonly N_ESTIMATORS = 300;
    private readonly MAX_DEPTH = 14;
    private readonly MIN_SAMPLES_SPLIT = 4;
    private readonly MAX_FEATURES = 0.85;

    // Indicator periods – optimized for 3min primary + 1h HTF
    private readonly RSI_PERIOD = 10;
    private readonly MACD_FAST = 12;
    private readonly MACD_SLOW = 26;
    private readonly MACD_SIGNAL = 9;
    private readonly STOCH_K = 14;
    private readonly STOCH_D = 3;
    private readonly ATR_PERIOD = 12;
    private readonly EMA_SHORT = 20;
    private readonly EMA_MID = 50;
    private readonly VWMA_PERIOD = 20;
    private readonly VWAP_PERIOD = 20;

    constructor() {
        this.classifier = new RandomForestClassifier({
            nEstimators: this.N_ESTIMATORS,
            seed: 42,
            treeOptions: { maxDepth: this.MAX_DEPTH, minSamplesSplit: this.MIN_SAMPLES_SPLIT },
            maxFeatures: this.MAX_FEATURES,
            replacement: true,
            useSampleBagging: true,
        });

        this.loadModel();
        logger.info('MLService initialized (5-tier labeling enabled)');
    }

    // ===========================================================================
    // MODEL PERSISTENCE – Safe load/save with corruption detection
    // ===========================================================================
    private async loadModel(): Promise<void> {
        try {
            const data = await fs.readFile(config.ml.modelPath, 'utf-8');
            const parsed = JSON.parse(data);
            const model = RandomForestClassifier.load(parsed);

            if (!model?.estimators?.length || model.estimators.some((t: any) => !t.root)) {
                throw new Error('Invalid or corrupt model structure');
            }

            this.classifier = model;
            this.isModelLoaded = true;
            logger.info('ML model loaded successfully', {
                trees: model.estimators.length,
                path: config.ml.modelPath,
            });
        } catch (err) {
            logger.warn('No valid model found – starting fresh', {
                error: err instanceof Error ? err.message : 'Unknown',
            });
            this.isModelLoaded = false;
        }
    }

    private async saveModel(): Promise<void> {
        try {
            const json = JSON.stringify(this.classifier);
            await fs.writeFile(config.ml.modelPath, json, 'utf-8');
            logger.info('ML model saved', { path: config.ml.modelPath });
        } catch (err) {
            logger.error('Failed to save ML model', { error: err instanceof Error ? err.stack : err });
            throw err;
        }
    }

    // ===========================================================================
    // FEATURE EXTRACTION – High-signal, consistent with training data
    // ===========================================================================
    public extractFeatures(input: StrategyInput): number[] {
        const { primaryData, htfData, price } = input;
        const f: number[] = [];

        // Primary timeframe indicators
        const emaShort = calculateEMA(primaryData.closes, this.EMA_SHORT);
        const emaMid = calculateEMA(primaryData.closes, this.EMA_MID);
        const rsi = calculateRSI(primaryData.closes, this.RSI_PERIOD);
        const macd = calculateMACD(primaryData.closes, this.MACD_FAST, this.MACD_SLOW, this.MACD_SIGNAL);
        const stoch = calculateStochastic(primaryData.highs, primaryData.lows, primaryData.closes, this.STOCH_K, this.STOCH_D);
        const atr = calculateATR(primaryData.highs, primaryData.lows, primaryData.closes, this.ATR_PERIOD);
        const obv = calculateOBV(primaryData.closes, primaryData.volumes);
        const vwma = calculateVWMA(primaryData.closes, primaryData.volumes, this.VWMA_PERIOD);
        const vwap = calculateVWAP(
            primaryData.highs,
            primaryData.lows,
            primaryData.closes,
            primaryData.volumes,
            this.VWAP_PERIOD
        );
        const bb = calculateBollingerBands(primaryData.closes, 20, 2);
        const momentum = calculateMomentum(primaryData.closes, 10);
        const engulfing = detectEngulfing(primaryData.opens, primaryData.highs, primaryData.lows, primaryData.closes);

        // HTF alignment
        const htfEma = calculateEMA(htfData.closes, 50);
        const htfRsi = calculateRSI(htfData.closes, 14);
        const htfAdx = calculateADX(htfData.highs, htfData.lows, htfData.closes, 14);

        // Binary structural features
        const priceAboveEmaShort = price > (emaShort.at(-1) ?? 0) ? 1 : 0;
        const priceAboveEmaMid = price > (emaMid.at(-1) ?? 0) ? 1 : 0;
        const priceAboveHtfEma = price > (htfEma.at(-1) ?? 0) ? 1 : 0;
        const rsiOversold = (rsi.at(-1) ?? 50) < 30 ? 1 : 0;
        const rsiOverbought = (rsi.at(-1) ?? 50) > 70 ? 1 : 0;
        const macdBullish = (macd.at(-1)?.MACD ?? 0) > (macd.at(-1)?.signal ?? 0) ? 1 : 0;
        const stochOversold = (stoch.at(-1)?.k ?? 50) < 20 ? 1 : 0;

        // Push all features
        f.push(
            emaShort.at(-1) ?? 0,
            emaMid.at(-1) ?? 0,
            rsi.at(-1) ?? 50,
            macd.at(-1)?.MACD ?? 0,
            macd.at(-1)?.signal ?? 0,
            macd.at(-1)?.histogram ?? 0,
            stoch.at(-1)?.k ?? 50,
            stoch.at(-1)?.d ?? 50,
            atr.at(-1) ?? 0,
            obv.at(-1) ?? 0,
            vwma.at(-1) ?? 0,
            htfEma.at(-1) ?? 0,
            htfRsi.at(-1) ?? 50,
            price,
            htfAdx.at(-1)?.adx ?? 0,
            htfAdx.at(-1)?.pdi ?? 0,
            htfAdx.at(-1)?.mdi ?? 0,
            vwap.at(-1) ?? 0,
            momentum.at(-1) ?? 0,
            engulfing.at(-1) === 'bullish' ? 1 : engulfing.at(-1) === 'bearish' ? -1 : 0,
            priceAboveEmaShort,
            priceAboveEmaMid,
            priceAboveHtfEma,
            rsiOversold,
            rsiOverbought,
            macdBullish,
            stochOversold,
            bb.at(-1)?.upper ? (price - bb.at(-1)!.upper!) / (bb.at(-1)!.upper! - bb.at(-1)!.lower!) : 0.5
        );

        return f;
    }

    // ===========================================================================
    // PREDICTION – Returns confidence in positive outcome (for long signals)
    // ===========================================================================
    public predict(features: number[]): { label: SignalLabel; confidence: number } {
        if (!this.isModelLoaded || this.classifier.estimators?.length === 0) {
            return { label: 0, confidence: 0 };
        }

        try {
            // Get probabilities for all possible labels
            const probabilities: Record<SignalLabel, number> = {
                [-2]: 0,
                [-1]: 0,
                0: 0,
                1: 0,
                2: 0,
            };
            for (const label of this.ALL_LABELS) {
                const probArray = this.classifier.predictProbability([features], label);
                probabilities[label] = probArray[0]; // probArray is [[prob]], so [0][0]
            }

            const pNeg2 = probabilities[-2];
            const pNeg1 = probabilities[-1];
            const pZero = probabilities[0];
            const pPos1 = probabilities[1];
            const pPos2 = probabilities[2];

            const positiveConfidence = pPos1 + pPos2;
            const predictedLabel: SignalLabel = pPos2 > pPos1 ? 2 : pPos1 >= 0.35 ? 1 : 0;

            logger.debug('ML Prediction', {
                confidence: positiveConfidence.toFixed(4),
                predictedLabel,
                probs: { '-2': pNeg2.toFixed(3), '-1': pNeg1.toFixed(3), '0': pZero.toFixed(3), '1': pPos1.toFixed(3), '2': pPos2.toFixed(3) },
            });

            return { label: predictedLabel, confidence: positiveConfidence };
        } catch (err) {
            logger.error('ML prediction failed', { error: err instanceof Error ? err.message : err });
            return { label: 0, confidence: 0 };
        }
    }

    // ===========================================================================
    // INGEST SIMULATED OUTCOME – Called from simulateTrade.ts
    // ===========================================================================
    public async ingestSimulatedOutcome(
        symbol: string,
        features: number[],
        label: SignalLabel,
        rMultiple: number,
        pnlPercent: number
    ): Promise<void> {
        if (this.isTrainingPaused) {
            logger.info('Training paused – skipping sample', { symbol, label });
            return;
        }

        try {
            await dbService.addTrainingSample({
                symbol,
                features,
                label, // Now correctly stores -2 to +2
            });

            logger.info('New training sample ingested', {
                symbol,
                label,
                rMultiple: rMultiple.toFixed(2),
                pnl: `${(pnlPercent * 100).toFixed(2)}%`,
                features: features.length,
            });

            const count = await dbService.getSampleCount();
            if (count >= config.ml.minSamplesToTrain && count % 20 === 0) {
                await this.retrain();
            }
        } catch (err) {
            logger.error('Failed to ingest training sample', { error: err instanceof Error ? err.stack : err });
        }
    }

    // ===========================================================================
    // RETRAIN MODEL
    // ===========================================================================
    private async retrain(): Promise<void> {
        if (this.isTrainingPaused) return;

        try {
            const samples = await dbService.getTrainingSamples();
            if (samples.length < config.ml.minSamplesToTrain) {
                logger.warn(`Not enough samples to retrain (${samples.length})`);
                return;
            }

            const X = samples.map(s => s.features);
            const y = samples.map(s => s.label); // Now multi-class: -2 to +2

            logger.info(`Retraining ML model on ${samples.length} samples...`);
            this.classifier.train(X, y);
            await this.saveModel();
            this.isModelLoaded = true;

            const dist = await dbService.getLabelDistribution();
            logger.info('Model retrained & saved', {
                samples: samples.length,
                distribution: dist.map(d => `${d.label}:${d.count}`).join(', '),
            });
        } catch (err) {
            logger.error('Retraining failed', { error: err instanceof Error ? err.stack : err });
        }
    }

    // ===========================================================================
    // CONTROL & STATUS
    // ===========================================================================
    public pauseTraining() {
        this.isTrainingPaused = true;
        logger.warn('ML training PAUSED');
    }

    public resumeTraining() {
        this.isTrainingPaused = false;
        logger.info('ML training RESUMED');
    }

    public async forceRetrain(): Promise<void> {
        logger.info('Force retrain triggered');
        await this.retrain();
    }

    public async getStatus(): Promise<string> {
        const count = await dbService.getSampleCount();
        const dist = await dbService.getLabelDistribution();
        return [
            `ML Model Status`,
            `├─ Loaded: ${this.isModelLoaded ? 'YES' : 'NO'} (${this.classifier.estimators?.length} trees)`,
            `├─ Training Paused: ${this.isTrainingPaused ? 'YES' : 'NO'}`,
            `├─ Total Samples: ${count}`,
            `└─ Label Distribution: ${dist.map(d => `${d.label}(${d.count})`).join(', ')}`,
        ].join('\n');
    }

    /**
     * Retrieves a summary of training samples by symbol.
     * - Includes total samples, buys, sells, and win rate per symbol.
     * @returns {Promise<string>} Formatted summary message.
     */
    public async getSampleSummary(): Promise<string> {
        try {
            const summary = await dbService.getSampleSummary();
            if (summary.length === 0) {
                logger.info('No training samples found for summary');
                return 'No training samples yet.';
            }
            const formatted = summary
                .map(s => `${s.symbol}: ${s.total} samples (${s.buys} buys, ${s.sells} sells; ${((s.wins / s.total) * 100).toFixed(1)}% wins)`)
                .join('\n');
            logger.debug('Retrieved sample summary', { symbols: summary.map(s => s.symbol) });
            return formatted;
        } catch (error) {
            logger.error('Failed to retrieve sample summary', { error: (error as Error).stack });
            return 'Error retrieving sample summary';
        }
    }
    
    /**
     * Retrieves performance metrics for trading outcomes.
     * - Includes total trades, overall win rate, and symbol-specific metrics.
     * @returns {Promise<string>} Formatted performance metrics message.
     */
    public async getPerformanceMetrics(): Promise<string> {
        try {
            const samples = await dbService.getTrainingSamples();
            if (samples.length === 0) {
                logger.info('No samples available for performance metrics');
                return 'No trade data available.';
            }

            const totalTrades = samples.length;
            const wins = samples.filter(s => s.label === 1).length;
            const winRate = ((wins / totalTrades) * 100).toFixed(1);
            const bySymbol = await dbService.getSampleSummary();

            const formatted = [
                `Total trades: ${totalTrades}`,
                `Win rate: ${winRate}%`,
                ...bySymbol.map(s => `${s.symbol}: ${s.total} trades, ${((s.wins / s.total) * 100).toFixed(1)}% wins`),
            ].join('\n');

            logger.debug('Retrieved performance metrics', { totalTrades, winRate });
            return formatted;
        } catch (error) {
            logger.error('Failed to retrieve performance metrics', { error: (error as Error).stack });
            return 'Error retrieving performance metrics';
        }
    }


    public isReady(): boolean {
        return this.isModelLoaded && (this.classifier.estimators?.length ?? 0) > 0;
    }
}

// Export singleton for easy import
export const mlService = new MLService();
