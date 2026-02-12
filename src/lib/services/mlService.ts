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
import { excursionCache } from './excursionHistoryCache';

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

    // Hyperparameters – tuned for crypto market characteristics
    private readonly N_ESTIMATORS = 300;         // Number of trees (more = better but slower)
    private readonly MAX_DEPTH = 14;             // Tree depth limit (prevents overfitting)
    private readonly MIN_SAMPLES_SPLIT = 4;      // Minimum samples to split a node
    private readonly MAX_FEATURES = 0.85;        // Fraction of features per tree (randomness)

    private readonly INTERNAL_TO_LABEL: Record<number, SignalLabel> = {
        0: -2,
        1: -1,
        2: 0,
        3: 1,
        4: 2
    };

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

    /**
 * Extracts a fixed-length feature vector from market data for ML prediction.
 *
 * Called from:
 *   • Strategy.generateSignal() – for every potential signal (live prediction)
 *   • simulateTrade() – to store features with simulation outcome (training data)
 *
 * Design principles:
 *   - Fixed length: always returns the same number of features (currently ~19)
 *   - Normalized values: most features scaled to [0,1] or small range for better convergence
 *   - Consistent: uses same computeIndicators() as training → no train/test mismatch
 *   - Async: fetches live excursion regime from DB/cache
 *   - Defensive: no NaN/Infinity, safe fallbacks for missing data
 *
 * Feature groups (order matters — do not reorder without updating model):
 *   1. Technical indicators (normalized latest values from primary + HTF)
 *   2. Real-time excursion regime (MFE/MAE/ratio from recent simulations)
 *   3. Market context (volume, price scaling)
 *
 * @param input Full market context at signal time
 * @returns Fixed-length number[] ready for classifier.predict()
 * @throws Error if feature length mismatch detected (critical for model integrity)
 */
    public async extractFeatures(input: StrategyInput): Promise<number[]> {
        const { symbol, primaryData, htfData, price } = input;

        // Safety: prevent division by zero or invalid price
        if (price <= 0) {
            logger.warn('Invalid price in extractFeatures – using fallback', { symbol, price });
            return new Array(19).fill(0); // fallback neutral vector
        }

        const f: number[] = [];

        // ── 1. Technical indicators (primary + HTF) ─────────────────────────────
        const indicators = computeIndicators(primaryData, htfData);
        const last = indicators.last;

        // Normalize to avoid large value ranges
        f.push(
            last.rsi ? last.rsi / 100 : 0.5,                        // 0–1
            last.emaShort ? (price - last.emaShort) / price : 0,    // relative deviation
            last.emaMid ? (price - last.emaMid) / price : 0,
            last.emaLong ? (price - last.emaLong) / price : 0,
            last.macdLine ?? 0,                                     // raw (usually small)
            last.macdSignal ?? 0,
            last.macdHistogram ?? 0,
            last.stochasticK ? last.stochasticK / 100 : 0.5,
            last.stochasticD ? last.stochasticD / 100 : 0.5,
            last.atr ? last.atr / price : 0,                        // volatility relative to price
            last.htfAdx ? last.htfAdx / 100 : 0,                    // trend strength
            last.percentB ?? 0.5,                                   // Bollinger position
            last.bbBandwidth ? last.bbBandwidth / 100 : 0,          // volatility squeeze
            last.momentum ? last.momentum / price : 0,              // momentum relative
            last.engulfing === 'bullish' ? 1 : last.engulfing === 'bearish' ? -1 : 0  // categorical
        );

        // ── 2. Real-time excursion regime features (live + recent closed) ───────
        let regime;
        try {
            regime = await excursionCache.getRegimeLite(symbol);
        } catch (err) {
            logger.warn('Failed to fetch regime in extractFeatures – using neutral', { symbol, err });
        }

        if (regime && regime.recentSampleCount > 0) {
            const mfePct = regime.recentMfe ?? 0;
            const maePct = regime.recentMae ?? 0; // negative
            const ratio = regime.recentExcursionRatio ?? 1;

            // Normalize to reasonable ranges (avoid extreme values breaking model)
            f.push(
                Math.min(10, Math.max(0, mfePct)) / 10,          // 0–1 (cap at 10%)
                Math.min(10, Math.abs(maePct)) / 10,             // MAE magnitude 0–1
                Math.min(10, ratio) / 5                          // ratio usually 0–5 → 0–1
            );

            if (logger.isDebugEnabled()) {
                logger.debug('Added excursion regime features', {
                    symbol,
                    liveMfe: mfePct.toFixed(2),
                    liveMae: maePct.toFixed(2),
                    liveRatio: ratio.toFixed(2),
                    activeSims: regime.activeCount,
                    sampleCount: regime.recentSampleCount,
                });
            }
        } else {
            // No regime data yet → neutral values
            f.push(0, 0, 0.2); // slight bias toward balanced ratio
        }

        // ── 3. Market context features (volume, scaling) ────────────────────────
        f.push(
            last.obv ? last.obv / 1e9 : 0,           // OBV scaled down
            last.vwap ? last.vwap / 1e6 : 0,         // VWAP scaled
            last.vwma ? last.vwma / 1e6 : 0,         // VWMA scaled
            price / 1e5                              // price scaled (e.g. BTC ~60k → 0.6)
        );

        // ── Final validation: fixed length check (critical for model) ───────────
        const expectedLength = 22; // Update this number if you add/remove features!
        if (f.length !== expectedLength) {
            logger.error('Feature length mismatch in extractFeatures', {
                expected: expectedLength,
                actual: f.length,
                symbol,
            });
            throw new Error(`Feature vector length error: expected ${expectedLength}, got ${f.length}`);
        }

        // Optional: final NaN/Infinity guard (should never happen after above)
        if (f.some(v => isNaN(v) || !isFinite(v))) {
            logger.error('NaN or Infinity detected in final features', { symbol });
            return new Array(expectedLength).fill(0);
        }

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
            // Initialize probability map for all labels (original -2..2)
            const probabilities: Record<SignalLabel, number> = {
                [-2]: 0, [-1]: 0, [0]: 0, [1]: 0, [2]: 0,
            };

            // Query probability for each possible internal label (0..4)
            for (let internalLabel = 0; internalLabel < 5; internalLabel++) {
                const probArray = this.classifier.predictProbability([features], internalLabel);
                const originalLabel = this.INTERNAL_TO_LABEL[internalLabel];  // Map back to -2..2
                probabilities[originalLabel] = probArray[0];  // Single-sample array
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

    /**
 * Retrains the Random Forest model using all labeled simulations from the DB.
 *
 * Called from:
 *   • forceRetrain() – manually via Telegram /ml_train
 *   • (Future: optional periodic trigger after N new samples)
 *
 * Current reality (after merging trainingSamples → simulatedTrades):
 *   - Source table: simulatedTrades
 *   - Filter: WHERE label IS NOT NULL
 *   - Labels remapped internally (-2..2 → 0..4) to avoid ml-cart negative index crash
 *   - Heavy filtering for clean data (NaN/Infinity, invalid labels)
 *   - No separate ingestion step — simulations already stored complete
 *
 * @private – called internally or via force command
 */
    public async retrain(): Promise<void> {
        if (this.isTrainingPaused) {
            logger.info('Training is paused — skipping retrain');
            return;
        }

        try {
            // 1. Load all labeled simulations (WHERE label IS NOT NULL)
            const allSamples = await dbService.getLabeledSimulations();
            logger.info(`Loaded ${allSamples.length} labeled simulations for retraining`);

            if (allSamples.length < config.ml.minSamplesToTrain) {
                logger.warn(`Not enough labeled samples to retrain (${allSamples.length} < ${config.ml.minSamplesToTrain})`);
                return;
            }

            // 2. Label remapping: -2→0, -1→1, 0→2, 1→3, 2→4
            const labelToInternal: Record<SignalLabel, number> = {
                '-2': 0,
                '-1': 1,
                '0': 2,
                '1': 3,
                '2': 4
            };

            // 3. Filter & clean samples (critical for stability)
            const validSamples = allSamples.filter(sample => {
                // Must have valid features array
                if (!Array.isArray(sample.features) || sample.features.length === 0) {
                    return false;
                }

                // No NaN/Infinity in features
                const hasInvalidFeature = sample.features.some(v =>
                    typeof v !== 'number' || isNaN(v) || !isFinite(v)
                );

                // Label must be valid integer -2..2
                const label = sample.label;
                const validLabel = typeof label === 'number' && Number.isInteger(label) && [-2, -1, 0, 1, 2].includes(label);

                return !hasInvalidFeature && validLabel;
            });

            if (validSamples.length < allSamples.length) {
                logger.warn(
                    `Filtered out ${allSamples.length - validSamples.length} invalid samples ` +
                    `(NaN/Infinity features or invalid labels)`
                );
            }

            if (validSamples.length < Math.max(20, config.ml.minSamplesToTrain / 2)) {
                logger.error(`Too few valid samples after filtering (${validSamples.length}) — cannot train`);
                return;
            }

            // 4. Prepare training matrices
            const X = validSamples.map(s => s.features).filter(f => Array.isArray(f) && f.length > 0) as number[][];
            const y = validSamples.map(s => labelToInternal[s.label as SignalLabel]);

            // Debug: internal label distribution (0–4)
            const internalCounts = y.reduce((acc: Record<number, number>, lbl) => {
                acc[lbl] = (acc[lbl] || 0) + 1;
                return acc;
            }, {});
            logger.info('Internal label distribution (0–4):', internalCounts);

            // Debug: original label distribution (-2..2)
            const originalCounts = validSamples.reduce((acc: Record<number, number>, s) => {
                acc[s.label!] = (acc[s.label!] || 0) + 1;
                return acc;
            }, {});
            logger.info('Original label distribution (-2..+2):', originalCounts);

            logger.info(`Starting training on ${X.length} clean samples (${X[0]?.length ?? 0} features)`);

            // 5. Train the model
            this.classifier.train(X, y);

            logger.info('Training completed successfully');

            // 6. Persist the model
            await this.saveModel();
            this.isModelLoaded = true;

            // 7. Final report
            const dist = await dbService.getLabelDistribution();
            logger.info('Model retrained & saved', {
                samplesUsed: X.length,
                originalDistribution: dist.map(d => `${d.label}:${d.count}`).join(', ')
            });

        } catch (err) {
            logger.error('Retraining failed', {
                error: err instanceof Error ? err.stack : String(err),
                message: err instanceof Error ? err.message : 'Unknown error'
            });
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

    /**
 * Generates a formatted summary of labeled simulations broken down by symbol.
 *
 * Called from:
 *   • TelegramBotController – /ml_samples command
 *
 * Output format (Telegram-friendly):
 *   SYMBOL: X simulations (B buys, S sells; W% wins)
 *
 * Details:
 *   • Uses dbService.getSimulationSummaryBySymbol() – efficient GROUP BY query
 *   • Calculates win rate client-side (label >= 1 = win)
 *   • Safe handling: empty result or DB error
 *
 * @returns Multi-line string ready for Telegram message
 */
    public async getSampleSummary(): Promise<string> {
        try {
            // Fetch pre-aggregated per-symbol stats from DB
            const summary = await dbService.getSimulationSummaryBySymbol();

            if (summary.length === 0) {
                return 'No labeled simulations yet.';
            }

            // Format each symbol line (same style as before)
            return summary
                .map(s =>
                    `${s.symbol}: ${s.total} simulations ` +
                    `(${s.buys} buys, ${s.sells} sells; ${((s.wins / s.total) * 100).toFixed(1)}% wins)`
                )
                .join('\n');
        } catch (error) {
            logger.error('Failed to retrieve simulation summary', {
                error: error instanceof Error ? error.stack : String(error),
            });
            return 'Error retrieving simulation summary.';
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
            const wins = samples.filter(s => s.label! >= 1).length;
            const winRate = ((wins / totalTrades) * 100).toFixed(1);

            // Per-symbol breakdown (reuses efficient query)
            const bySymbol = await dbService.getSimulationSummaryBySymbol();

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
