// src/lib/config/settings.ts
// =============================================================================
// CENTRAL CONFIGURATION – SINGLE SOURCE OF TRUTH
// Uses Zod + dotenv for bulletproof validation & defaults
// All modules import from here → no scattered env vars
// Fully supports:
//   • 5-tier ML labeling
//   • Partial take-profits & trailing stops
//   • High-precision simulation
//   • Live vs testnet mode
//   • Per-environment tuning
// =============================================================================

import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env early
dotenvConfig();

/**
 * Zod schema – validates every config value at startup
 * Throws clear error if anything is missing or wrong
 */
const ConfigSchema = z.object({
    // ──────────────────────────────────────────────────────────────
    // Core Environment
    // ──────────────────────────────────────────────────────────────
    ENV: z.enum(['dev', 'test', 'prod']).default('dev'),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

    // ──────────────────────────────────────────────────────────────
    // Database
    // ──────────────────────────────────────────────────────────────
    DATABASE_URL: z.string().url(),

    // ──────────────────────────────────────────────────────────────
    // Exchange & Trading Mode
    // ──────────────────────────────────────────────────────────────
    AUTO_TRADE: z.coerce.boolean().default(false),                    // Master kill switch
    EXCHANGE: z.enum(['bybit', 'gate', 'binance']).default('bybit'),
    EXCHANGE_API_KEY: z.string().optional(),
    EXCHANGE_API_SECRET: z.string().optional(),

    // ──────────────────────────────────────────────────────────────
    // Telegram Notifications
    // ──────────────────────────────────────────────────────────────
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),

    // ──────────────────────────────────────────────────────────────
    // Symbols & Timeframes
    // ──────────────────────────────────────────────────────────────
    SYMBOLS: z.string().default('BTC/USDT,ETH/USDT').transform(str => str.split(',').map(s => s.trim())),
    TIMEFRAME: z.string().default('3m'),           // Primary scanner timeframe
    HTF_TIMEFRAME: z.string().default('1h'),       // Higher timeframe filter

    // ──────────────────────────────────────────────────────────────
    // Scanner Behavior
    // ──────────────────────────────────────────────────────────────
    SCAN_INTERVAL_MS: z.coerce.number().default(60_000),     // How often to run full scan
    HEARTBEAT_INTERVAL: z.coerce.number().default(30),       // Telegram heartbeat every N cycles
    HISTORY_LENGTH: z.coerce.number().min(100).default(300), // Candles to keep in memory

    // ──────────────────────────────────────────────────────────────
    // Risk Management & Position Sizing
    // ──────────────────────────────────────────────────────────────
    ATR_MULTIPLIER: z.coerce.number().default(1.5),          // Stop-loss distance
    RISK_REWARD_TARGET: z.coerce.number().default(3.0),      // Target R:R (e.g., 3 = 3:1)
    TRAILING_STOP_PERCENT: z.coerce.number().default(0.6),   // Trailing activation % of move
    POSITION_SIZE_PERCENT: z.coerce.number().min(0.1).max(10).default(1.0), // % of balance per trade
    LEVERAGE: z.coerce.number().default(5),

    // ──────────────────────────────────────────────────────────────
    // 5-Tier ML Labeling Thresholds (R-multiple based)
    // ──────────────────────────────────────────────────────────────
    ML_LABEL_STRONG_WIN: z.coerce.number().default(3.0),     // R ≥ 3.0 → label +2
    ML_LABEL_GOOD_WIN: z.coerce.number().default(1.5),       // R ≥ 1.5 → label +1
    ML_LABEL_BREAK_EVEN: z.coerce.number().default(-0.5),    // R ≥ -0.5 → label 0
    ML_LABEL_SMALL_LOSS: z.coerce.number().default(-1.5),    // R ≥ -1.5 → label -1
    // Below -1.5 → label -2 (strong loss)

    // ──────────────────────────────────────────────────────────────
    // Simulation Engine
    // ──────────────────────────────────────────────────────────────
    SIMULATION_TIMEOUT_MINUTES: z.coerce.number().default(60),      // Max hold time
    SIMULATION_POLL_INTERVAL_MS: z.coerce.number().default(15_000), // 15s precision
    SIMULATION_DEFAULT_RISK_PCT: z.coerce.number().default(1.5),    // Fallback risk if no SL

    // ──────────────────────────────────────────────────────────────
    // Partial Take-Profit Configuration
    // ──────────────────────────────────────────────────────────────
    PARTIAL_TP_LEVELS: z.string().default('1.5:0.4,3.0:0.3,6.0:0.3').transform(str => {
        // Format: "1.5:0.4,3.0:0.3,5.0:0.3" → [{price: 1.5R, weight: 0.4}, ...]
        return str.split(',').map(part => {
            const [rStr, weightStr] = part.split(':');
            return {
                rMultiple: parseFloat(rStr),
                weight: parseFloat(weightStr),
            };
        });
    }), // Default: 40% at 1.5R, 30% at 3R, 30% at 6R

    // ──────────────────────────────────────────────────────────────
    // ML Training
    // ──────────────────────────────────────────────────────────────
    MIN_SAMPLES_TO_TRAIN: z.coerce.number().default(150),
    MODEL_PATH: z.string().default('./models/rf_model.json'),
    TRAINING_MODE: z.coerce.boolean().default(true),

    // ──────────────────────────────────────────────────────────────
    // Confidence & Filters
    // ──────────────────────────────────────────────────────────────
    CONFIDENCE_THRESHOLD: z.coerce.number().min(30).max(95).default(68),
    MIN_ADX_TREND: z.coerce.number().default(20),
    MIN_BB_BANDWIDTH_PCT: z.coerce.number().default(0.5), // Avoid flat markets
    MIN_AVG_VOLUME_USD_PER_HOUR: z.coerce.number().default(50_000),

    // ──────────────────────────────────────────────────────────────
    // Worker & Locking
    // ──────────────────────────────────────────────────────────────
    LOCK_TYPE: z.enum(['file', 'database']).default('database'),
    SCANNER_MODE: z.enum(['single', 'periodic']).default('periodic'),
});

/**
 * Parse & validate – will throw clear error on startup if config is wrong
 */
const rawConfig = ConfigSchema.parse(process.env);

/**
 * Final exported config – typed, validated, and enriched
 */
export const config = {
    // Core
    env: rawConfig.ENV,
    log_level: rawConfig.LOG_LEVEL,

    // Exchange
    autoTrade: Boolean(
        rawConfig.AUTO_TRADE &&
        rawConfig.EXCHANGE_API_KEY &&
        rawConfig.EXCHANGE_API_SECRET
    ),
    exchange: {
        name: rawConfig.EXCHANGE,
        apiKey: rawConfig.EXCHANGE_API_KEY,
        apiSecret: rawConfig.EXCHANGE_API_SECRET,
    },

    // Telegram
    telegram: {
        token: rawConfig.TELEGRAM_BOT_TOKEN,
        chatId: rawConfig.TELEGRAM_CHAT_ID,
    },

    // Symbols & Timeframes
    symbols: rawConfig.SYMBOLS,
    scanner: {
        primaryTimeframe: rawConfig.TIMEFRAME,
        htfTimeframe: rawConfig.HTF_TIMEFRAME,
        scanIntervalMs: rawConfig.SCAN_INTERVAL_MS,
        heartBeatInterval: rawConfig.HEARTBEAT_INTERVAL,
    },

    // Risk & Position
    strategy: {
        atrMultiplier: rawConfig.ATR_MULTIPLIER,
        riskRewardTarget: rawConfig.RISK_REWARD_TARGET,
        trailingStopPercent: rawConfig.TRAILING_STOP_PERCENT,
        positionSizePercent: rawConfig.POSITION_SIZE_PERCENT,
        leverage: rawConfig.LEVERAGE,
        confidenceThreshold: rawConfig.CONFIDENCE_THRESHOLD,
        minAdxTrend: rawConfig.MIN_ADX_TREND,
        minBbBandwidthPct: rawConfig.MIN_BB_BANDWIDTH_PCT,
        minAvgVolumeUsdPerHour: rawConfig.MIN_AVG_VOLUME_USD_PER_HOUR,
    },

    // 5-Tier ML Labeling
    ml: {
        labelThresholds: {
            strongWin: rawConfig.ML_LABEL_STRONG_WIN,
            goodWin: rawConfig.ML_LABEL_GOOD_WIN,
            breakEven: rawConfig.ML_LABEL_BREAK_EVEN,
            smallLoss: rawConfig.ML_LABEL_SMALL_LOSS,
        },
        minSamplesToTrain: rawConfig.MIN_SAMPLES_TO_TRAIN,
        modelPath: rawConfig.MODEL_PATH,
        trainingEnabled: rawConfig.TRAINING_MODE,
    },

    // Simulation
    simulation: {
        timeoutMinutes: rawConfig.SIMULATION_TIMEOUT_MINUTES,
        pollIntervalMs: rawConfig.SIMULATION_POLL_INTERVAL_MS,
        defaultRiskPct: rawConfig.SIMULATION_DEFAULT_RISK_PCT,
        partialTpLevels: rawConfig.PARTIAL_TP_LEVELS,
    },

    // Worker
    worker: {
        lockType: rawConfig.LOCK_TYPE,
        scannerMode: rawConfig.SCANNER_MODE,
    },

    // DB
    databaseUrl: rawConfig.DATABASE_URL,

    // History
    historyLength: rawConfig.HISTORY_LENGTH,
};

/**
 * Type export – use this everywhere for type safety
 */
export type Config = typeof config;
