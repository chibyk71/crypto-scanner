// src/lib/services/mlService.ts
// =============================================================================
// ML SERVICE – 5-TIER RANDOM FOREST CLASSIFIER (FULLY TYPE-SAFE + PRODUCTION READY)
//
// Purpose:
//   • Continuously learns from high-fidelity simulated trade outcomes
//   • Predicts probability of profitable trades using 5-tier labeling
//   • Integrates excursion data (MAE/MFE) for better risk-aware predictions
//   • Provides model status, training control, and performance reporting
//
// Key Features:
//   • 5-tier labels: -2 (disaster), -1 (loss), 0 (neutral), +1 (good), +2 (monster win)
//   • Automatic retraining when enough new samples are collected
//   • Persistent model (saved/loaded from JSON file)
//   • Training can be paused/resumed/forced via Telegram commands
//   • Uses centralized indicators + symbol-specific excursion history
// =============================================================================

import * as fs from 'fs/promises';
import { RandomForestClassifier } from 'ml-random-forest';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import { dbService } from '../db';
import type { StrategyInput, SignalLabel } from '../../types'; // ← Critical: from single source of truth
import { computeIndicators } from '../utils/indicatorUtils';   // ← Centralized indicator calculations

/**
 * Dedicated logger for all ML-related operations
 * Tagged as 'MLService' for easy filtering in logs
 */
const logger = createLogger('MLService');

/**
 * MLService – The adaptive learning brain of the trading bot
 *
 * Responsibilities:
 *   • Extract features from market data (indicators + excursions)
 *   • Predict outcome probability and label for new signals
 *   • Ingest completed simulation results as training data
 *   • Retrain model periodically
 *   • Persist model to disk
 *   • Provide status and control interface (via Telegram)
 */
export class MLService {
    // Core Random Forest classifier instance
    private classifier: RandomForestClassifier;

    // Flags for model state
    private isModelLoaded = false;     // Has a valid model been loaded from disk?
    private isTrainingPaused = false;  // Manual pause (via /ml_pause command)

    // Complete set of possible labels – used for probability calculation
    private readonly ALL_LABELS: SignalLabel[] = [-2, -1, 0, 1, 2];

    // Hyperparameters – tuned for crypto market characteristics
    private readonly N_ESTIMATORS = 300;         // Number of trees (more = better but slower)
    private readonly MAX_DEPTH = 14;             // Tree depth limit (prevents overfitting)
    private readonly MIN_SAMPLES_SPLIT = 4;      // Minimum samples to split a node
    private readonly MAX_FEATURES = 0.85;        // Fraction of features per tree (randomness)

    // =========================================================================
    // CONSTRUCTOR – Initialize classifier and attempt to load saved model
    // =========================================================================
    constructor() {
        // Create fresh classifier with tuned hyperparameters
        this.classifier = new RandomForestClassifier({
            nEstimators: this.N_ESTIMATORS,
            seed: 42,                                   // Fixed seed for reproducibility
            treeOptions: { maxDepth: this.MAX_DEPTH, minSamplesSplit: this.MIN_SAMPLES_SPLIT },
            maxFeatures: this.MAX_FEATURES,
            replacement: true,                          // Bootstrap sampling
            useSampleBagging: true,
        });

        // Attempt to load existing model from disk
        this.loadModel();
        logger.info('MLService initialized (5-tier labeling + excursion features enabled)');
    }

    // =========================================================================
    // MODEL PERSISTENCE – Load saved Random Forest model from disk
    // =========================================================================
    /**
     * Attempts to load a previously trained model from the filesystem.
     *
     * Called automatically:
     *   • In the constructor during MLService initialization
     *
     * Why this matters:
     *   • Avoids retraining from scratch on every bot restart
     *   • Enables continuous learning over days/weeks
     *   • Fast startup – predictions available immediately if model exists
     *
     * Behavior:
     *   • Reads JSON file at config.ml.modelPath
     *   • Parses and validates structure (must have valid trees)
     *   • On success: sets classifier and flags isModelLoaded = true
     *   • On failure (missing file, corrupt, invalid): starts with fresh classifier
     *
     * @private – only called internally during init
     */
    private async loadModel(): Promise<void> {
        try {
            // Read raw JSON string from disk
            const data = await fs.readFile(config.ml.modelPath, 'utf-8');

            // Parse JSON into object
            const parsed = JSON.parse(data);

            // Load into ml-random-forest's format
            const model = RandomForestClassifier.load(parsed);

            // Basic validation: ensure model has trees and they are well-formed
            if (!model?.estimators?.length || model.estimators.some((t: any) => !t.root)) {
                throw new Error('Invalid or corrupt model structure');
            }

            // Success – replace current classifier with loaded one
            this.classifier = model;
            this.isModelLoaded = true;

            // Log success with useful diagnostics
            logger.info('ML model loaded successfully', {
                trees: model.estimators.length,
                path: config.ml.modelPath,
            });
        } catch (err) {
            // Expected cases: file not found, JSON parse error, corrupt data
            logger.warn('No valid model found – starting fresh', {
                error: err instanceof Error ? err.message : 'Unknown',
            });

            // Keep fresh classifier, mark as not loaded
            this.isModelLoaded = false;
        }
    }

    // =========================================================================
    // MODEL PERSISTENCE – Save current model to disk
    // =========================================================================
    /**
     * Serializes and saves the current trained model to disk.
     *
     * Called from:
     *   • retrain() – after successful training
     *
     * Why important:
     *   • Persists learned knowledge across bot restarts
     *   • Enables long-term adaptation to market changes
     *
     * Behavior:
     *   • Converts classifier to JSON string
     *   • Writes atomically to config.ml.modelPath
     *   • Throws on failure (caller should handle)
     *
     * @private – only called after retraining
     * @throws Error if write fails (disk full, permissions, etc.)
     */
    private async saveModel(): Promise<void> {
        try {
            // Serialize entire classifier (trees, hyperparameters, etc.)
            const json = JSON.stringify(this.classifier);

            // Write to configured path (overwrites old model)
            await fs.writeFile(config.ml.modelPath, json, 'utf-8');

            // Confirm success
            logger.info('ML model saved', { path: config.ml.modelPath });
        } catch (err) {
            // Critical error – model knowledge would be lost on restart
            logger.error('Failed to save ML model', {
                error: err instanceof Error ? err.stack : err
            });
            throw err; // Let caller decide how to handle (e.g., alert admin)
        }
    }

    // ===========================================================================
    // FEATURE EXTRACTION – Build normalized prediction vector
    // ===========================================================================
    /**
     * Extracts a fixed-length feature vector from market data for ML prediction.
     *
     * Called from:
     *   • Strategy.generateSignal() – for every potential signal
     *   • simulateAndTrain() – to store features with simulation outcome
     *
     * Design:
     *   • Uses centralized computeIndicators() → consistent with training data
     *   • Combines technical indicators + symbol-specific excursion history
     *   • All values normalized/scaled for better model convergence
     *   • Async because it fetches excursion stats from DB
     *
     * Feature groups:
     *   1. Technical indicators (latest values)
     *   2. Historical excursion metrics (MFE/MAE from symbolHistory)
     *   3. Market regime (volume, price scaling)
     *
     * @param input - Full market context (symbol, OHLCV, current price)
     * @returns Fixed-length number[] ready for classifier.predict()
     */
    public async extractFeatures(input: StrategyInput): Promise<number[]> {
        const { symbol, primaryData, htfData, price } = input;
        const f: number[] = [];

        // === 1. Centralized technical indicators (primary + HTF) ===
        const indicators = computeIndicators(primaryData, htfData);
        const last = indicators.last;

        f.push(
            last.rsi / 100,
            last.emaShort ? (price - last.emaShort) / price : 0,
            last.emaMid ? (price - last.emaMid) / price : 0,
            last.emaLong ? (price - last.emaLong) / price : 0,
            last.macdLine,
            last.macdSignal,
            last.macdHistogram,
            last.stochasticK / 100,
            last.stochasticD / 100,
            last.atr / price,
            last.htfAdx / 100,
            last.percentB,
            last.bbBandwidth / 100,
            last.momentum / price,
            last.engulfing === 'bullish' ? 1 : last.engulfing === 'bearish' ? -1 : 0
        );

        // === 2. REAL-TIME Excursion features (live + recent closed) ===
        const regime = await dbService.getCurrentRegime(symbol);

        if (regime.sampleCount > 0) {
            const mfePct = regime.mfe;
            const maePct = regime.mae; // negative
            const ratio = regime.excursionRatio;

            // Normalize to reasonable ranges
            f.push(
                mfePct / 10,           // e.g., 5% → 0.5
                Math.abs(maePct) / 10, // MAE magnitude
                ratio / 5              // e.g., ratio 3 → 0.6
            );

            logger.debug('Added real-time excursion features', {
                symbol,
                liveMfe: mfePct.toFixed(2),
                liveMae: maePct.toFixed(2),
                liveRatio: ratio.toFixed(2),
                activeSims: regime.activeCount,
            });
        } else {
            // No data yet → neutral
            f.push(0, 0, 1); // ratio = 1 = balanced
        }

        // === 3. Market regime features – volume and price scaling ===
        f.push(
            last.obv / 1e9,
            last.vwap / 1e6,
            last.vwma / 1e6,
            price / 1e5
        );

        return f;
    }

    // ===========================================================================
    // PREDICTION – Evaluate feature vector and return label + confidence
    // ===========================================================================
    /**
     * Runs prediction on a feature vector using the loaded Random Forest model.
     *
     * Called from:
     *   • Strategy.generateSignal() – to add ML bonus to signal score
     *
     * Logic:
     *   • If no model loaded → neutral (0 confidence)
     *   • Queries probability for all 5 labels
     *   • Confidence = P(label 1) + P(label 2) → probability of profit
     *   • Predicted label: 2 if strong win likely, 1 if moderate, else 0
     *
     * @param features - Vector from extractFeatures()
     * @returns { label: predicted outcome, confidence: profit probability }
     */
    public predict(features: number[]): { label: SignalLabel; confidence: number } {
        // Safety check – no model available yet
        if (!this.isModelLoaded || this.classifier.estimators?.length === 0) {
            return { label: 0, confidence: 0 };
        }

        try {
            // Initialize probability map for all labels
            const probabilities: Record<SignalLabel, number> = {
                [-2]: 0, [-1]: 0, 0: 0, 1: 0, 2: 0,
            };

            // Query probability for each possible label
            for (const label of this.ALL_LABELS) {
                const probArray = this.classifier.predictProbability([features], label);
                probabilities[label] = probArray[0];  // Single-sample array
            }

            // Extract individual probabilities
            const pNeg2 = probabilities[-2];
            const pNeg1 = probabilities[-1];
            const pZero = probabilities[0];
            const pPos1 = probabilities[1];
            const pPos2 = probabilities[2];

            // Confidence = probability of any profitable outcome
            const positiveConfidence = pPos1 + pPos2;

            // Determine strongest predicted label
            // Prioritize strong wins (2), then moderate (1), else neutral
            const predictedLabel: SignalLabel = pPos2 > pPos1 ? 2 : pPos1 >= 0.35 ? 1 : 0;

            // Debug log for monitoring prediction quality
            logger.debug('ML Prediction', {
                confidence: positiveConfidence.toFixed(4),
                predictedLabel,
                probs: { '-2': pNeg2.toFixed(3), '-1': pNeg1.toFixed(3), '0': pZero.toFixed(3), '1': pPos1.toFixed(3), '2': pPos2.toFixed(3) },
            });

            return { label: predictedLabel, confidence: positiveConfidence };
        } catch (err) {
            // Any error → fall back to neutral (safe default)
            logger.error('ML prediction failed', { error: err instanceof Error ? err.message : err });
            return { label: 0, confidence: 0 };
        }
    }

    // ===========================================================================
    // INGEST SIMULATED OUTCOME – Add new labeled sample from completed simulation
    // ===========================================================================
    /**
     * Stores a new training sample after a simulation finishes.
     *
     * Called from:
     *   • MarketScanner.simulateAndTrain() – after closeSimulatedTrade()
     *
     * Responsibilities:
     *   • Save to database (persistent)
     *   • Trigger periodic retraining (every 20 new samples after threshold)
     *   • Respect training pause state
     *
     * @param symbol - Trading pair
     * @param features - Vector from extractFeatures() at signal time
     * @param label - Final 5-tier outcome
     * @param rMultiple - For logging
     * @param pnlPercent - For logging
     */
    public async ingestSimulatedOutcome(
        symbol: string,
        features: number[],
        label: SignalLabel,
        rMultiple: number,
        pnlPercent: number
    ): Promise<void> {
        // Respect manual pause (via /ml_pause)
        if (this.isTrainingPaused) {
            logger.info('Training paused – skipping sample', { symbol, label });
            return;
        }

        try {
            // Persist sample to database
            await dbService.addTrainingSample({
                symbol,
                features,
                label,
            });

            // Rich log for monitoring data quality
            logger.info('New training sample ingested', {
                symbol,
                label,
                rMultiple: rMultiple.toFixed(2),
                pnl: `${(pnlPercent * 100).toFixed(2)}%`,
                features: features.length,
            });

            // Periodic retraining trigger
            const count = await dbService.getSampleCount();
            if (count >= config.ml.minSamplesToTrain && count % 20 === 0) {
                await this.retrain();
            }
        } catch (err) {
            logger.error('Failed to ingest training sample', { error: err instanceof Error ? err.stack : err });
        }
    }

    // ===========================================================================
    // RETRAINING – Train model on all accumulated samples
    // ===========================================================================
    /**
     * Retrains the Random Forest model using all stored training samples.
     *
     * Called from:
     *   • ingestSimulatedOutcome() – periodically
     *   • /ml_train command – manually
     *
     * Process:
     *   • Load all samples from DB
     *   • Skip if below minimum threshold
     *   • Train classifier
     *   • Save updated model to disk
     *   • Log new label distribution
     *
     * @private – only called internally or via force command
     */
    private async retrain(): Promise<void> {
        // Respect pause state
        if (this.isTrainingPaused) return;

        try {
            // Load full dataset
            const samples = await dbService.getTrainingSamples();
            if (samples.length < config.ml.minSamplesToTrain) {
                logger.warn(`Not enough samples to retrain (${samples.length})`);
                return;
            }

            // Prepare training matrices
            const X = samples.map(s => s.features);  // Feature vectors
            const y = samples.map(s => s.label);     // Labels

            logger.info(`Retraining ML model on ${samples.length} samples...`);

            // Perform training
            this.classifier.train(X, y);

            // Persist new model
            await this.saveModel();
            this.isModelLoaded = true;

            // Report new class balance
            const dist = await dbService.getLabelDistribution();
            logger.info('Model retrained & saved', {
                samples: samples.length,
                distribution: dist.map(d => `${d.label}:${d.count}`).join(', '),
            });
        } catch (err) {
            logger.error('Retraining failed', { error: err instanceof Error ? err.stack : err });
        }
    }

    // =========================================================================
    // TRAINING CONTROL: Manually pause ML training
    // =========================================================================
    /**
     * Pauses automatic ML model training.
     *
     * Called from:
     *   • TelegramBotController – /ml_pause command
     *
     * Purpose:
     *   • Temporarily stop ingesting new samples and retraining
     *   • Useful during market anomalies, backtesting, or debugging
     *   • Does NOT affect predictions (loaded model still works)
     *
     * State:
     *   • Sets isTrainingPaused = true
     *   • ingestSimulatedOutcome() will skip saving samples
     *   • retrain() will early-return
     */
    public pauseTraining() {
        this.isTrainingPaused = true;
        logger.warn('ML training PAUSED');
    }

    // =========================================================================
    // TRAINING CONTROL: Resume normal ML training
    // =========================================================================
    /**
     * Resumes automatic training after a pause.
     *
     * Called from:
     *   • TelegramBotController – /ml_resume command
     *
     * Behavior:
     *   • Clears pause flag
     *   • New simulations will again be saved and trigger retraining
     */
    public resumeTraining() {
        this.isTrainingPaused = false;
        logger.info('ML training RESUMED');
    }

    // =========================================================================
    // TRAINING CONTROL: Force immediate retraining
    // =========================================================================
    /**
     * Triggers a full model retrain regardless of sample count or pause state.
     *
     * Called from:
     *   • TelegramBotController – /ml_train command
     *
     * Use cases:
     *   • After manual data fixes or imports
     *   • When you want fresh predictions immediately
     *   • Debugging model performance
     *
     * Note:
     *   • Still respects minimum sample threshold in retrain()
     *   • Logs clearly for monitoring
     */
    public async forceRetrain(): Promise<void> {
        logger.info('Force retrain triggered');
        await this.retrain();
    }

    // =========================================================================
    // STATUS REPORTING: Formatted ML system status
    // =========================================================================
    /**
     * Returns a human-readable status summary of the ML system.
     *
     * Used by:
     *   • TelegramBotController – /ml_status command
     *   • Debugging and monitoring tools
     *
     * Includes:
     *   • Whether model is loaded and how many trees
     *   • Training pause state
     *   • Total training samples
     *   • Current label distribution (-2 to +2)
     *
     * @returns Multi-line string formatted for easy reading
     */
    public async getStatus(): Promise<string> {
        // Fetch latest counts from database
        const count = await dbService.getSampleCount();
        const dist = await dbService.getLabelDistribution();

        // Tree-style formatted status
        return [
            `ML Model Status`,
            `├─ Loaded: ${this.isModelLoaded ? 'YES' : 'NO'} (${this.classifier.estimators?.length ?? 0} trees)`,
            `├─ Training Paused: ${this.isTrainingPaused ? 'YES' : 'NO'}`,
            `├─ Total Samples: ${count}`,
            `└─ Label Distribution: ${dist.map(d => `${d.label}(${d.count})`).join(', ')}`,
        ].join('\n');
    }

    // =========================================================================
    // REPORTING: Per-symbol training sample summary (Telegram friendly)
    // =========================================================================
    /**
     * Generates a formatted summary of training samples broken down by symbol.
     *
     * Called from:
     *   • TelegramBotController – /ml_samples command
     *
     * Output format:
     *   SYMBOL: X samples (B buys, S sells; W% wins)
     *
     * Details:
     *   • Uses dbService.getSampleSummary() – efficient GROUP BY query
     *   • Calculates win rate client-side for clean formatting
     *   • Safe handling: empty dataset or DB error
     *
     * @returns Multi-line string ready for Telegram message
     */
    public async getSampleSummary(): Promise<string> {
        try {
            // Fetch pre-aggregated per-symbol stats from DB
            const summary = await dbService.getSampleSummary();

            // No data yet
            if (summary.length === 0) return 'No training samples yet.';

            // Format each symbol line
            return summary
                .map(s => `${s.symbol}: ${s.total} samples (${s.buys} buys, ${s.sells} sells; ${((s.wins / s.total) * 100).toFixed(1)}% wins)`)
                .join('\n');
        } catch (error) {
            // Log full stack for debugging, return user-friendly message
            logger.error('Failed to retrieve sample summary', { error: (error as Error).stack });
            return 'Error retrieving sample summary';
        }
    }

    // =========================================================================
    // REPORTING: Overall ML performance metrics
    // =========================================================================
    /**
     * Provides high-level performance statistics across all simulations.
     *
     * Called from:
     *   • TelegramBotController – /ml_performance command
     *
     * Metrics:
     *   • Total simulated trades
     *   • Global win rate (label >= 1)
     *   • Per-symbol win rate breakdown
     *
     * Why separate from getSampleSummary?
     *   • Focuses on performance (win rate) vs raw sample counts
     *   • Used for quick health check of the strategy
     *
     * @returns Multi-line string with global + per-symbol metrics
     */
    public async getPerformanceMetrics(): Promise<string> {
        try {
            // Load full dataset for global calculation
            const samples = await dbService.getTrainingSamples();
            if (samples.length === 0) return 'No trade data available.';

            const totalTrades = samples.length;

            // Count profitable outcomes (label 1 or 2)
            const wins = samples.filter(s => s.label >= 1).length;
            const winRate = ((wins / totalTrades) * 100).toFixed(1);

            // Per-symbol breakdown (reuses efficient query)
            const bySymbol = await dbService.getSampleSummary();

            // Build formatted report
            return [
                `Total trades: ${totalTrades}`,
                `Win rate: ${winRate}%`,
                ...bySymbol.map(s => `${s.symbol}: ${s.total} trades, ${((s.wins / s.total) * 100).toFixed(1)}% wins`),
            ].join('\n');
        } catch (error) {
            logger.error('Failed to retrieve performance metrics', { error: (error as Error).stack });
            return 'Error retrieving performance metrics';
        }
    }

    // =========================================================================
    // HEALTH CHECK: Is the ML model ready for predictions?
    // =========================================================================
    /**
     * Quick check if a trained model is loaded and valid.
     *
     * Used by:
     *   • Strategy.generateSignal() – to decide whether to use ML bonus
     *   • Status commands and monitoring
     *
     * Returns true only if:
     *   • Model successfully loaded from disk
     *   • Has at least one decision tree
     *
     * @returns true if predictions are available
     */
    public isReady(): boolean {
        // Must be loaded AND have actual trees
        return this.isModelLoaded && (this.classifier.estimators?.length ?? 0) > 0;
    }
}

// Export singleton for easy import
export const mlService = new MLService();
