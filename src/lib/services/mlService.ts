// src/lib/services/mlService.ts
// =============================================================================
// ML SERVICE – ONNX INFERENCE (XGBoost trained locally via ml/train.py)
//
// Purpose:
//   • Load and run a pre-trained XGBoost model exported as ONNX
//   • Extract features from market data for prediction
//   • Provide status and control interface via Telegram
//
// Training workflow (no longer happens in Node.js):
//   1. Send /export_training_data to Telegram → download CSV
//   2. Run ml/train.py locally → produces ml/models/model.onnx
//   3. Run ml/validate.py → confirm model is healthy
//   4. Upload model.onnx to production models/model.onnx
//   5. Send /ml_reload to Telegram → hot-swap without restart
//
// Key changes from previous version:
//   • RandomForestClassifier removed entirely
//   • onnxruntime-node used for inference
//   • predict() is now async (ONNX Runtime is async)
//   • reloadModel() added for hot-swap via Telegram
//   • extractFeatures() adds symbol index as feature [25] → length 26
//   • retrain/saveModel/loadModel (RF versions) removed
// =============================================================================

import * as fs from 'fs/promises';
import * as ort from 'onnxruntime-node';
import { createLogger } from '../logger';
import { config } from '../config/settings';
import { dbService } from '../db';
import type { StrategyInput, SignalLabel } from '../../types';
import { computeIndicators } from '../utils/indicatorUtils';
import { excursionCache } from './excursionHistoryCache';
import { symbolRegistry } from '../utils/symbolRegistry';
import path from 'path';

const logger = createLogger('MLService');

export class MLService {
    // ONNX inference session — null until model is loaded
    private session: ort.InferenceSession | null = null;

    // Model state flags
    private isModelLoaded = false;
    private isTrainingPaused = false;  // kept for API compatibility with Telegram commands

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================
    constructor() {
        // Non-blocking load — bot starts immediately, predictions become
        // available once the file is read (usually < 1 second)
        this.loadModel().catch(err => {
            logger.warn('Model load failed at startup — predictions disabled', {
                error: err instanceof Error ? err.message : String(err),
            });
        });

        logger.info('MLService initialized (ONNX inference mode)');
    }

    // =========================================================================
    // MODEL LOADING
    // =========================================================================
    /**
     * Loads the ONNX model from disk into an inference session.
     *
     * Called:
     *   • Automatically in constructor at startup
     *   • Manually via reloadModel() after uploading a new model
     *
     * Behavior:
     *   • Reads model.onnx from config.ml.modelPath
     *   • Creates an ort.InferenceSession
     *   • Sets isModelLoaded = true on success
     *   • On failure: logs warning, leaves isModelLoaded = false
     *     (bot continues without ML predictions rather than crashing)
     */
    private async loadModel(): Promise<void> {
        try {
            const modelPath = path.resolve(config.ml.modelPath);

            // Check file exists before attempting to create session
            // (ort gives a cryptic error if the file is missing)
            await fs.access(modelPath);

            logger.info('Loading ONNX model...', { path: modelPath });

            this.session = await ort.InferenceSession.create(modelPath, {
                executionProviders: ['cpu'],   // shared hosting has no GPU
                graphOptimizationLevel: 'all', // maximize CPU inference speed
            });

            this.isModelLoaded = true;

            // Log input/output info so mismatches are immediately visible
            const inputNames = this.session.inputNames;
            const outputNames = this.session.outputNames;

            logger.info('ONNX model loaded successfully', {
                path: modelPath,
                inputs: inputNames,
                outputs: outputNames,
            });

            // Sanity check — warn if output node name is wrong
            // mlService reads 'probabilities' — must match what train.py exports
            if (!outputNames.includes('probabilities')) {
                logger.warn(
                    'ONNX model does not have a "probabilities" output node. ' +
                    `Found: [${outputNames.join(', ')}]. ` +
                    'Predictions will fail. Retrain and re-export.'
                );
            }

        } catch (err) {
            this.session = null;
            this.isModelLoaded = false;

            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';

            if (isNotFound) {
                logger.warn('No ONNX model found — predictions disabled until model.onnx is uploaded', {
                    path: config.ml.modelPath,
                    hint: 'Run ml/train.py locally then upload models/model.onnx',
                });
            } else {
                logger.error('Failed to load ONNX model', {
                    path: config.ml.modelPath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    // =========================================================================
    // HOT-SWAP: Reload model without restarting the bot
    // =========================================================================
    /**
     * Reloads the ONNX model from disk.
     *
     * Called from:
     *   • TelegramBotController — /ml_reload command
     *
     * Use case:
     *   After uploading a new model.onnx to the server, send /ml_reload
     *   to activate it immediately without restarting the bot process.
     *
     * Behavior:
     *   • Clears current session
     *   • Re-runs loadModel()
     *   • Returns status string for Telegram reply
     */
    public async reloadModel(): Promise<string> {
        logger.info('Model reload requested');

        // Clear existing session first
        this.session = null;
        this.isModelLoaded = false;

        try {
            await this.loadModel();

            if (this.isModelLoaded) {
                return '✅ Model reloaded successfully. Predictions are active.';
            } else {
                return '❌ Model reload failed — check logs for details.';
            }
        } catch (err) {
            return `❌ Model reload error: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    // =========================================================================
    // FEATURE EXTRACTION
    // =========================================================================
    /**
     * Extracts a fixed-length feature vector from market data.
     *
     * Called from:
     *   • Strategy._computeScores() — for every potential signal
     *   • simulateTrade() — to store features with simulation outcome
     *
     * Feature groups (order is fixed — do not reorder without retraining):
     *   [0–14]  Technical indicators (RSI, EMA deviations, MACD, etc.)
     *   [15–20] Excursion regime (buy MFE/MAE/ratio + sell MFE/MAE/ratio)
     *   [21–24] Market context (OBV delta, VWAP deviation, VWMA-VWAP spread, relative volume)
     *   [25]    Symbol index (normalized stable index from symbolRegistry)
     *
     * Total: 26 features
     *
     * Normalization notes (2026 update):
     *   [4,5,6]  MACD values divided by price — cross-symbol consistent scale
     *   [21]     OBV delta / current candle volume — direction + magnitude, not cumulative level
     *   [22]     (price - vwap) / price — deviation from VWAP, not absolute price
     *   [23]     (vwma - vwap) / price — VWMA vs VWAP spread, not absolute value
     *   [24]     relative volume ratio capped at 5, normalized to 0–1 — volume surge magnitude
     *
     * @param input Full market context at signal time
     * @returns Fixed-length number[] of length 26
     */
    public async extractFeatures(input: StrategyInput): Promise<number[]> {
        const { symbol, primaryData, htfData, price } = input;

        if (price <= 0) {
            logger.warn('Invalid price in extractFeatures – returning neutral vector', { symbol, price });
            return new Array(26).fill(0);
        }

        const f: number[] = [];

        // ── 1. Technical indicators [0–14] ───────────────────────────────────
        const indicators = computeIndicators(primaryData, htfData);
        const last = indicators.last;

        f.push(
            last.rsi ? last.rsi / 100 : 0.5,                                    // [0]
            last.emaShort ? (price - last.emaShort) / price : 0,                // [1]
            last.emaMid ? (price - last.emaMid) / price : 0,                    // [2]
            last.emaLong ? (price - last.emaLong) / price : 0,                  // [3]
            last.macdLine ? last.macdLine / price : 0,                          // [4] normalized by price
            last.macdSignal ? last.macdSignal / price : 0,                      // [5] normalized by price
            last.macdHistogram ? last.macdHistogram / price : 0,                // [6] normalized by price
            last.stochasticK ? last.stochasticK / 100 : 0.5,                   // [7]
            last.stochasticD ? last.stochasticD / 100 : 0.5,                   // [8]
            last.atr ? last.atr / price : 0,                                    // [9]
            last.htfAdx ? last.htfAdx / 100 : 0,                               // [10]
            last.percentB ?? 0.5,                                               // [11]
            last.bbBandwidth ? last.bbBandwidth / 100 : 0,                     // [12]
            last.momentum ? last.momentum / price : 0,                         // [13]
            last.engulfing === 'bullish' ? 1 : last.engulfing === 'bearish' ? -1 : 0  // [14]
        );

        // ── 2. Excursion regime features [15–20] ─────────────────────────────
        let regime;
        try {
            regime = excursionCache.getRegimeLite(symbol);
        } catch (err) {
            logger.warn('Failed to fetch regime in extractFeatures', { symbol, err });
        }

        let buyMfe = 0, buyMae = 0, buyRatio = 0.2;
        let sellMfe = 0, sellMae = 0, sellRatio = 0.2;

        if (regime?.buy && regime.buy.sampleCount > 0) {
            buyMfe = Math.min(10, Math.max(0, regime.buy.mfe ?? 0)) / 10;
            buyMae = Math.min(10, Math.abs(regime.buy.mae ?? 0)) / 10;
            buyRatio = Math.min(10, regime.buy.excursionRatio ?? 1) / 5;
        }

        if (regime?.sell && regime.sell.sampleCount > 0) {
            sellMfe = Math.min(10, Math.max(0, regime.sell.mfe ?? 0)) / 10;
            sellMae = Math.min(10, Math.abs(regime.sell.mae ?? 0)) / 10;
            sellRatio = Math.min(10, regime.sell.excursionRatio ?? 1) / 5;
        }

        f.push(buyMfe, buyMae, buyRatio);    // [15–17]
        f.push(sellMfe, sellMae, sellRatio); // [18–20]

        if (logger.isDebugEnabled()) {
            logger.debug('Excursion features', {
                symbol,
                buy: { mfe: buyMfe.toFixed(3), mae: buyMae.toFixed(3), ratio: buyRatio.toFixed(3), samples: regime?.buy?.sampleCount ?? 0 },
                sell: { mfe: sellMfe.toFixed(3), mae: sellMae.toFixed(3), ratio: sellRatio.toFixed(3), samples: regime?.sell?.sampleCount ?? 0 },
            });
        }

        // ── 3. Market context [21–24] ─────────────────────────────────────────

        // [21] OBV delta normalized by current candle volume
        // Captures direction + relative magnitude of volume flow, not cumulative level
        const obvDelta = indicators.obv.length > 1
            ? indicators.last.obv - indicators.obv[indicators.obv.length - 2]
            : 0;
        const currentVolume = primaryData.volumes[primaryData.volumes.length - 1] || 1;
        const obvFeature = obvDelta / currentVolume;

        // [22] Price deviation from VWAP — how far price is from volume-weighted anchor
        const vwapDeviation = last.vwap && last.vwap > 0
            ? (price - last.vwap) / price
            : 0;

        // [23] VWMA vs VWAP spread — volume-weighted MA relative to VWAP anchor
        const vwmaVwapSpread = last.vwma && last.vwap && last.vwap > 0
            ? (last.vwma - last.vwap) / price
            : 0;

        // [24] Relative volume ratio — current candle volume vs 20-candle average
        // Capped at 5x to prevent extreme spikes from dominating, then normalized to 0–1
        const volLookback = 20;
        const recentVolumes = primaryData.volumes.slice(-(volLookback + 1), -1);
        const avgVolume20 = recentVolumes.length > 0
            ? recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length
            : currentVolume;
        const rawVolumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;
        const relativeVolumeFeature = Math.min(rawVolumeRatio, 5) / 5; // normalized 0–1

        f.push(
            obvFeature,             // [21]
            vwapDeviation,          // [22]
            vwmaVwapSpread,         // [23]
            relativeVolumeFeature,  // [24]
        );

        // ── 4. Symbol identity [25] ───────────────────────────────────────────
        if (!symbolRegistry.isKnown(symbol)) {
            logger.warn('Unknown symbol in extractFeatures — model may generalize poorly', {
                symbol,
                hint: 'Add to config.symbols and retrain',
            });
        }
        f.push(symbolRegistry.getIndex(symbol)); // [25]

        // ── Validation ────────────────────────────────────────────────────────
        // 15 technical + 6 excursion + 4 context + 1 symbol = 26
        const expectedLength = 26;
        if (f.length !== expectedLength) {
            logger.error('Feature length mismatch', { expected: expectedLength, actual: f.length, symbol });
            throw new Error(`Feature vector length error: expected ${expectedLength}, got ${f.length}`);
        }

        if (f.some(v => isNaN(v) || !isFinite(v))) {
            logger.error('NaN or Infinity in features — returning neutral vector', { symbol });
            return new Array(expectedLength).fill(0);
        }

        return f;
    }

    // =========================================================================
    // PREDICTION
    // =========================================================================
    /**
     * Runs inference on a feature vector using the loaded ONNX model.
     *
     * Called from:
     *   • Strategy._computeScores() — await this.mlService.predict(features)
     *
     * Note: This is async because onnxruntime-node's session.run() is async.
     * The caller in strategy.ts must await this call.
     *
     * @param features Vector from extractFeatures() — must be length 26
     * @returns { label, confidence } where confidence = P(label +1) + P(label +2)
     */
    public async predict(features: number[]): Promise<{ label: SignalLabel; confidence: number }> {
        if (!this.isModelLoaded || !this.session) {
            return { label: 0, confidence: 0 };
        }

        try {
            // ONNX Runtime expects a Float32Array in a named tensor
            // Input name must match what train.py exported ('float_input')
            const inputTensor = new ort.Tensor(
                'float32',
                Float32Array.from(features),
                [1, features.length]  // batch of 1
            );

            const feeds = { float_input: inputTensor };
            const results = await this.session.run(feeds);

            // XGBoost ONNX exports two outputs:
            //   'label'         — argmax class (int64)
            //   'probabilities' — softmax probabilities per class (float32)
            // We use probabilities for nuanced confidence calculation
            const probTensor = results['probabilities'];
            if (!probTensor) {
                logger.error('ONNX output "probabilities" not found', {
                    availableOutputs: Object.keys(results),
                });
                return { label: 0, confidence: 0 };
            }

            const probData = probTensor.data as Float32Array;

            // Internal labels 0..4 map back to -2..+2
            const pNeg2 = probData[0];
            const pNeg1 = probData[1];
            const pZero = probData[2];
            const pPos1 = probData[3];
            const pPos2 = probData[4];

            // Confidence = combined probability of any profitable outcome
            const positiveConfidence = pPos1 + pPos2;

            // Strongest predicted label
            const predictedLabel: SignalLabel = pPos2 > pPos1 ? 2 : pPos1 >= 0.35 ? 1 : 0;

            logger.debug('ONNX Prediction', {
                predictedLabel,
                confidence: positiveConfidence.toFixed(4),
                probs: {
                    '-2': pNeg2.toFixed(3),
                    '-1': pNeg1.toFixed(3),
                    ' 0': pZero.toFixed(3),
                    '+1': pPos1.toFixed(3),
                    '+2': pPos2.toFixed(3),
                },
            });

            return { label: predictedLabel, confidence: positiveConfidence };

        } catch (err) {
            logger.error('ONNX prediction failed', {
                error: err instanceof Error ? err.message : String(err),
                featuresLength: features.length,
            });
            return { label: 0, confidence: 0 };
        }
    }

    // =========================================================================
    // TRAINING CONTROL (no-ops in ONNX mode — kept for API compatibility)
    // =========================================================================
    // These methods are called by existing Telegram commands (/ml_pause etc).
    // They are kept so nothing else in the codebase needs to change.
    // Actual training happens in ml/train.py on your local machine.

    public pauseTraining(): void {
        this.isTrainingPaused = true;
        logger.info('ML training paused (no-op in ONNX mode — training is local)');
    }

    public resumeTraining(): void {
        this.isTrainingPaused = false;
        logger.info('ML training resumed (no-op in ONNX mode — training is local)');
    }

    public async retrain(): Promise<void> {
        logger.info('retrain() called — in ONNX mode, run ml/train.py locally');
    }

    public async forceRetrain(): Promise<void> {
        logger.info(
            'forceRetrain() called — training now happens locally.\n' +
            '  Steps: export CSV → run ml/train.py → validate → upload → /ml_reload'
        );
    }

    // =========================================================================
    // STATUS REPORTING
    // =========================================================================
    public async getStatus(): Promise<string> {
        const count = await dbService.getSampleCount();
        const dist = await dbService.getLabelDistribution();

        const modelInfo = this.isModelLoaded
            ? 'YES (ONNX — XGBoost)'
            : 'NO — upload model.onnx and send /ml_reload';

        return [
            'ML Model Status',
            `├─ Engine:          ONNX Runtime (inference only)`,
            `├─ Model Loaded:    ${modelInfo}`,
            `├─ Training Paused: ${this.isTrainingPaused ? 'YES' : 'NO'} (training is local)`,
            `├─ Total Samples:   ${count}`,
            `└─ Label Dist:      ${dist.map(d => `${d.label}(${d.count})`).join(', ')}`,
        ].join('\n');
    }

    public async getSampleSummary(): Promise<string> {
        try {
            const summary = await dbService.getSimulationSummaryBySymbol();
            if (summary.length === 0) return 'No labeled simulations yet.';
            return summary
                .map(s =>
                    `${s.symbol}: ${s.total} simulations ` +
                    `(${s.buys} buys, ${s.sells} sells; ${((s.wins / s.total) * 100).toFixed(1)}% wins)`
                )
                .join('\n');
        } catch (err) {
            logger.error('Failed to retrieve simulation summary', { error: err });
            return 'Error retrieving simulation summary.';
        }
    }

    public async getPerformanceMetrics(): Promise<string> {
        try {
            const samples = await dbService.getTrainingSamples();
            if (samples.length === 0) return 'No trade data available.';

            const totalTrades = samples.length;
            const wins = samples.filter(s => s.label! >= 1).length;
            const winRate = ((wins / totalTrades) * 100).toFixed(1);
            const bySymbol = await dbService.getSimulationSummaryBySymbol();

            return [
                `Total trades: ${totalTrades}`,
                `Win rate: ${winRate}%`,
                ...bySymbol.map(s =>
                    `${s.symbol}: ${s.total} trades, ${((s.wins / s.total) * 100).toFixed(1)}% wins`
                ),
            ].join('\n');
        } catch (err) {
            logger.error('Failed to retrieve performance metrics', { error: err });
            return 'Error retrieving performance metrics.';
        }
    }

    // =========================================================================
    // HEALTH CHECK
    // =========================================================================
    public isReady(): boolean {
        return this.isModelLoaded && this.session !== null;
    }
}

// Singleton — same pattern as before, nothing else needs to change
export const mlService = new MLService();
