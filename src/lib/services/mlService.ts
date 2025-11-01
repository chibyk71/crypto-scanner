// src/lib/services/mlService.ts

import * as fs from 'fs/promises';
import { RandomForestClassifier } from 'ml-random-forest';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import {
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateStochastic,
    calculateATR,
    calculateOBV,
    calculateVWMA,
    calculateVWAP,
} from '../indicators';
import type { StrategyInput } from '../strategy';
import { dbService } from '../db';

/**
 * Logger instance for MLService operations.
 * - Tagged with 'MLService' for categorized logging.
 */
const logger = createLogger('MLService');

/**
 * Interface for in-memory training samples.
 * - Mirrors the database `training_samples` table structure.
 */
export interface TrainingSample {
    features: number[];
    label: number;
}

/**
 * Manages the machine learning model for trading signal prediction and training.
 * - Uses RandomForestClassifier for predicting trade outcomes.
 * - Stores training samples in the database (`training_samples` table) for online learning.
 * - Provides methods for training control, feature extraction, and performance metrics.
 */
export class MLService {
    private rfClassifier: RandomForestClassifier;
    private isModelLoaded: boolean = false;
    private isTrainingPaused: boolean = false;
    private readonly rsiPeriod: number = 10;
    private readonly macdFast: number = 5;
    private readonly macdSlow: number = 13;
    private readonly macdSignal: number = 8;
    private readonly stochPeriod: number = 14;
    private readonly stochSignal: number = 3;
    private readonly atrPeriod: number = 12;
    private readonly emaShortPeriod: number = 20;
    private readonly vwmaPeriod: number = 20;
    private readonly vwapPeriod: number = 20;
    private readonly htfEmaMidPeriod: number = 50;

    /**
     * Initializes the ML service.
     * - Creates a new RandomForestClassifier with predefined hyperparameters.
     * - Attempts to load an existing model from disk.
     * - Note: Training data is now managed via the database, not file storage.
     */
    constructor() {
        this.rfClassifier = new RandomForestClassifier({
            nEstimators: 100,
            seed: 42,
            treeOptions: { maxDepth: 10, minSamplesSplit: 5 },
            maxFeatures: 0.8,
            replacement: true,
            useSampleBagging: true,
        });
        this.loadModel();
        logger.info('MLService initialized');
    }

    /**
     * Loads a saved Random Forest model from disk.
     * - Attempts to read the model from `config.modelPath`.
     * @private
     * @throws {Error} If the model file is corrupted or unreadable.
     */
    private async loadModel(): Promise<void> {
        try {
            const modelData = await fs.readFile(config.modelPath, 'utf8');
            const parsedModel = JSON.parse(modelData);
            const loadedModel = RandomForestClassifier.load(parsedModel);

            if (loadedModel && loadedModel.estimators) {
                // Check if ALL estimators (trees) have a valid root property.
                // This is a common point of failure for ml-cart internal structure.
                const invalidEstimators = loadedModel.estimators.filter(e => !e.root || !e.root.numberSamples);

                if (invalidEstimators.length > 0) {
                    // Log a severe error and refuse to load the model
                    logger.error('CRITICAL: Loaded Random Forest model is corrupt. Found missing tree structures.', { count: invalidEstimators.length });
                    this.isModelLoaded = false;
                    throw new Error('Corrupt model loaded.'); // Halt execution
                }
            }

            this.rfClassifier = loadedModel;
            this.isModelLoaded = true;
            logger.info('Random Forest model loaded successfully');
        } catch (error) {
            logger.warn('No saved model found or failed to load', { error: (error as Error).stack });
            this.isModelLoaded = false;
        }
    }

    /**
     * Saves the current Random Forest model to disk.
     * - Writes the model to `config.modelPath` as JSON.
     * @private
     * @throws {Error} If writing to the file fails.
     */
    private async saveModel(): Promise<void> {
        try {
            const modelJson = JSON.stringify(this.rfClassifier);
            await fs.writeFile(config.modelPath, modelJson);
            logger.info(`Model saved to ${config.modelPath}`);
        } catch (error) {
            logger.error(`Failed to save model to ${config.modelPath}`, { error: (error as Error).stack });
            throw error;
        }
    }

    /**
     * Extracts features from market data for ML prediction.
     * - Computes technical indicators (EMA, RSI, MACD, etc.) from primary and higher timeframe data.
     * - Returns a feature vector for use in prediction or training.
     * @param input - Strategy input containing primary and higher timeframe OHLCV data and current price.
     * @returns {number[]} Array of feature values (e.g., EMA, RSI, MACD, etc.).
     */
    public extractFeatures(input: StrategyInput): number[] {
        const { primaryData, htfData, price } = input;
        const features: number[] = [];

        // Calculate technical indicators
        const emaShort = calculateEMA(primaryData.closes, this.emaShortPeriod);
        const rsi = calculateRSI(primaryData.closes, this.rsiPeriod);
        const macd = calculateMACD(primaryData.closes, this.macdFast, this.macdSlow, this.macdSignal);
        const stochastic = calculateStochastic(primaryData.highs, primaryData.lows, primaryData.closes, this.stochPeriod, this.stochSignal);
        const atr = calculateATR(primaryData.highs, primaryData.lows, primaryData.closes, this.atrPeriod);
        const obv = calculateOBV(primaryData.closes, primaryData.volumes);
        const vwma = calculateVWMA(primaryData.closes, primaryData.volumes, this.vwmaPeriod);
        const vwap = calculateVWAP(primaryData.highs, primaryData.lows, primaryData.closes, primaryData.volumes, this.vwapPeriod);
        const htfEma = calculateEMA(htfData.closes, this.htfEmaMidPeriod);

        // Push latest values to feature vector, defaulting to 0 if undefined
        features.push(
            emaShort.at(-1) ?? 0,
            rsi.at(-1) ?? 0,
            macd.at(-1)?.MACD ?? 0,
            macd.at(-1)?.signal ?? 0,
            stochastic.at(-1)?.k ?? 0,
            stochastic.at(-1)?.d ?? 0,
            atr.at(-1) ?? 0,
            obv.at(-1) ?? 0,
            vwma.at(-1) ?? 0,
            vwap.at(-1) ?? 0,
            htfEma.at(-1) ?? 0,
            price
        );

        logger.debug(`Extracted ${features.length} features for prediction`, { price });
        return features;
    }

    /**
     * Adds a training sample to the database.
     * - Stores the sample in the `training_samples` table with symbol, features, and label.
     * - Triggers model retraining if the sample count meets or exceeds `minSamplesToTrain`.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @param features - Feature vector for the ML model.
     * @param label - Trade outcome (1 for win, -1 for loss).
     * @throws {Error} If database insertion fails.
     */
    public async addTrainingSample(symbol: string, features: number[], label: number): Promise<void> {
        if (this.isTrainingPaused) {
            logger.info(`Training paused, skipping sample for ${symbol}`);
            return;
        }

        try {
            const mappedLabel = label === 1 ? 1 : 0;
            await dbService.addTrainingSample({ symbol, features, label:mappedLabel });
            logger.debug(`Added training sample for ${symbol}: original_label=${label}, mapped_label=${mappedLabel}`);

            const sampleCount = await dbService.getSampleCount();
            if (sampleCount >= config.minSamplesToTrain) {
                await this.trainModel();
            }
        } catch (error) {
            logger.error(`Failed to add training sample for ${symbol}`, { error: (error as Error ).stack });
            throw error;
        }
    }

    /**
     * Trains the Random Forest model using all samples from the database.
     * - Retrieves samples from the `training_samples` table and trains the model.
     * - Saves the updated model to disk if training is successful.
     * @private
     * @throws {Error} If training or model saving fails.
     */
    private async trainModel(): Promise<void> {
        if (this.isTrainingPaused) {
            logger.info('Training paused, skipping model training');
            return;
        }

        try {
            const samples = await dbService.getTrainingSamples();
            if (samples.length < config.minSamplesToTrain) {
                logger.warn(`Insufficient samples (${samples.length}/${config.minSamplesToTrain}) to train model`);
                return;
            }

            const features = samples.map(s => s.features);
            const labels = samples.map(s => s.label);
            this.rfClassifier.train(features, labels);
            await this.saveModel();
            this.isModelLoaded = true;
            logger.info(`Model trained on ${samples.length} samples`);
        } catch (error) {
            logger.error('Failed to train model', { error: (error as Error).stack });
            throw error;
        }
    }

    /**
     * Forces immediate model training, bypassing sample count checks.
     * - Useful for manual retraining via Telegram commands.
     * @throws {Error} If training or model saving fails.
     */
    public async forceTrain(): Promise<void> {
        try {
            await this.trainModel();
            logger.info('Forced model training completed');
        } catch (error) {
            logger.error('Forced training failed', { error: (error as Error).stack });
            throw error;
        }
    }

    /**
     * Pauses ML model training.
     * - Prevents new samples from triggering retraining.
     */
    public pauseTraining(): void {
        this.isTrainingPaused = true;
        logger.info('ML training paused');
    }

    /**
     * Resumes ML model training.
     * - Allows new samples to trigger retraining if conditions are met.
     */
    public resumeTraining(): void {
        this.isTrainingPaused = false;
        logger.info('ML training resumed');
    }

    /**
     * Retrieves the current training status.
     * - Includes sample count, model status, and training pause state.
     * @returns {Promise<string>} Formatted status message.
     */
    public async getTrainingStatus(): Promise<string> {
        try {
            const sampleCount = await dbService.getSampleCount();
            const status = [
                `Training samples: ${sampleCount}/${config.minSamplesToTrain}`,
                `Model trained: ${this.isModelLoaded ? 'Yes' : 'No'}`,
                `Training paused: ${this.isTrainingPaused ? 'Yes' : 'No'}`,
            ].join('\n');
            logger.debug('Retrieved training status', { sampleCount });
            return status;
        } catch (error) {
            logger.error('Failed to retrieve training status', { error: (error as Error).stack });
            return 'Error retrieving training status';
        }
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

    /**
     * Predicts the probability of a positive outcome for a given label.
     * - Returns 0 if the model is not trained.
     * @param features - Feature vector for prediction.
     * @param expectedLabel - Expected label (1 for buy, -1 for sell).
     * @returns {number} Probability of the expected label (0 to 1).
     */
    public predict(features: number[], expectedLabel: number): number {
        if (!this.isModelLoaded) {
            logger.warn('Prediction attempted but model is not trained');
            return 0;
        }
        try {
            const mappedExpected = expectedLabel === 1 ? 1 : 0;
            const probability = this.rfClassifier.predictProbability([features], mappedExpected)[0];
            logger.debug(`Prediction made: probability=${probability} for original_label=${expectedLabel}, mapped_label=${mappedExpected}`);
            return probability;
        } catch (error) {
            console.log(error)
            logger.error('Prediction failed', { error: (error as Error).stack, features });
            return 0;
        }
    }

    /**
     * Checks if the model is trained and ready for predictions.
     * @returns {boolean} True if the model is trained, false otherwise.
     */
    public isModelTrained(): boolean {
        logger.debug(`Model trained status: ${this.isModelLoaded}`);
        return this.isModelLoaded;
    }
}
