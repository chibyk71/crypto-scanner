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
//   • Excursion-based strategy adjustments (MAE/MFE)
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
    AUTO_TRADE: z.coerce.boolean().default(false),
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
    TIMEFRAME: z.string().default('3m'),
    HTF_TIMEFRAME: z.string().default('1h'),

    // ──────────────────────────────────────────────────────────────
    // Scanner Behavior
    // ──────────────────────────────────────────────────────────────
    SCAN_INTERVAL_MS: z.coerce.number().default(60_000),
    HEARTBEAT_INTERVAL: z.coerce.number().default(30),
    HISTORY_LENGTH: z.coerce.number().min(100).default(300),

    // ──────────────────────────────────────────────────────────────
    // Risk Management & Position Sizing
    // ──────────────────────────────────────────────────────────────
    ATR_MULTIPLIER: z.coerce.number().default(1.5),
    RISK_REWARD_TARGET: z.coerce.number().default(3.0),
    TRAILING_STOP_PERCENT: z.coerce.number().default(0.6),
    POSITION_SIZE_PERCENT: z.coerce.number().min(0.1).max(10).default(1.0),
    LEVERAGE: z.coerce.number().default(5),

    // ──────────────────────────────────────────────────────────────
    // NEW: REGIME-AWARE & REVERSAL TRADING CONTROLS
    // ──────────────────────────────────────────────────────────────
    /**
     * Enables automatic signal reversal in AutoTradeService when recent reversals are detected
     * Only applies to live trading – Strategy alerts remain pure
     */
    AUTO_TRADE_REVERSAL_ENABLED: z.coerce.boolean().default(false),

    /**
     * Time window (in hours) for "recent" excursion and reversal statistics
     * Used in symbolHistory recent fields and regime detection
     */
    RECENT_WINDOW_HOURS: z.coerce.number().min(1).max(24).default(3),

    /**
     * Minimum number of recent simulations required before applying regime adjustments
     * Prevents overreaction on sparse data
     */
    MIN_RECENT_SAMPLES_FOR_ADJUSTMENT: z.coerce.number().min(1).default(1),

    /**
     * Minimum recent reversal count required to trigger auto-reversal in AutoTrade
     * Only used when AUTO_TRADE_REVERSAL_ENABLED = true
     */
    MIN_REVERSE_COUNT_FOR_AUTO_REVERSAL: z.coerce.number().min(1).default(3),

    // ──────────────────────────────────────────────────────────────
    // 5-Tier ML Labeling Thresholds (R-multiple based)
    // ──────────────────────────────────────────────────────────────
    ML_LABEL_STRONG_WIN: z.coerce.number().default(3.0),
    ML_LABEL_GOOD_WIN: z.coerce.number().default(1.5),
    ML_LABEL_BREAK_EVEN: z.coerce.number().default(-0.5),
    ML_LABEL_SMALL_LOSS: z.coerce.number().default(-1.5),

    // ──────────────────────────────────────────────────────────────
    // Simulation Engine
    // ──────────────────────────────────────────────────────────────
    SIMULATION_TIMEOUT_MINUTES: z.coerce.number().default(60),
    SIMULATION_POLL_INTERVAL_MS: z.coerce.number().default(15_000),
    SIMULATION_DEFAULT_RISK_PCT: z.coerce.number().default(1.5),

    // ──────────────────────────────────────────────────────────────
    // Partial Take-Profit Configuration
    // ──────────────────────────────────────────────────────────────
    PARTIAL_TP_LEVELS: z.string().default('1.5:0.4,3.0:0.3,6.0:0.3').transform(str => {
        return str.split(',').map(part => {
            const [rStr, weightStr] = part.split(':');
            return {
                rMultiple: parseFloat(rStr),
                weight: parseFloat(weightStr),
            };
        });
    }),

    // ──────────────────────────────────────────────────────────────
    // ML Training
    // ──────────────────────────────────────────────────────────────
    MIN_SAMPLES_TO_TRAIN: z.coerce.number().default(150),
    MODEL_PATH: z.string().default('./models/rf_model.json'),
    TRAINING_MODE: z.coerce.boolean().default(true),

    // ──────────────────────────────────────────────────────────────
    // Confidence & Filters
    // ──────────────────────────────────────────────────────────────
    CONFIDENCE_THRESHOLD: z.coerce.number().min(50).max(95).default(68),
    MIN_ADX_TREND: z.coerce.number().default(20),
    MIN_BB_BANDWIDTH_PCT: z.coerce.number().default(0.5),
    MIN_AVG_VOLUME_USD_PER_HOUR: z.coerce.number().default(50_000),

    // ──────────────────────────────────────────────────────────────
    // Excursion-Based Strategy Adjustments
    // ──────────────────────────────────────────────────────────────
    MAX_MAE_PCT: z.coerce.number().default(2.0),                    // Max allowed average MAE (%) before penalizing
    MIN_EXCURSION_RATIO: z.coerce.number().default(1.5),            // Minimum MFE/MAE ratio for confidence boost
    EXCURSION_CONFIDENCE_BOOST: z.coerce.number().default(0.1),     // +10% confidence if ratio >= min


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
 *
 * This is the **single source of truth** for the entire bot's configuration.
 * All values come from environment variables (validated by Zod), with defaults applied.
 *
 * Why this structure?
 *   • Clean grouping by module (strategy, scanner, ml, etc.)
 *   • Type-safe – you get autocomplete and compile-time checks everywhere
 *   • Easy to extend – just add new fields to Zod schema and here
 */
export const config = {
    // =========================================================================
    // CORE ENVIRONMENT
    // =========================================================================
    /**
     * Current runtime environment
     * Used for logging level, debug features, and conditional behavior
     */
    env: rawConfig.ENV,                    // 'dev' | 'test' | 'prod'
    log_level: rawConfig.LOG_LEVEL,        // Controls Winston logger verbosity

    // =========================================================================
    // AUTOTRADE MASTER SWITCH
    // =========================================================================
    /**
     * Whether live trading is enabled
     * Only true if:
     *   • AUTO_TRADE=true in .env
     *   • API key AND secret are provided
     * This prevents accidental live trading in dev/test
     */
    autoTrade: Boolean(
        rawConfig.AUTO_TRADE &&
        rawConfig.EXCHANGE_API_KEY &&
        rawConfig.EXCHANGE_API_SECRET
    ),

    // =========================================================================
    // EXCHANGE CONFIGURATION
    // =========================================================================
    exchange: {
        /** Exchange name (bybit, gate, binance) */
        name: rawConfig.EXCHANGE,
        /** API key – required for live trading */
        apiKey: rawConfig.EXCHANGE_API_KEY,
        /** API secret – required for live trading */
        apiSecret: rawConfig.EXCHANGE_API_SECRET,
    },

    // =========================================================================
    // TELEGRAM NOTIFICATIONS
    // =========================================================================
    telegram: {
        /** Bot token from BotFather */
        token: rawConfig.TELEGRAM_BOT_TOKEN,
        /** Your personal chat ID – bot only responds to this */
        chatId: rawConfig.TELEGRAM_CHAT_ID,
    },

    // =========================================================================
    // SYMBOLS & SCANNING
    // =========================================================================
    /** List of trading pairs to scan (e.g., ['BTC/USDT', 'ETH/USDT']) */
    symbols: rawConfig.SYMBOLS,

    scanner: {
        /** Primary timeframe for fast signals (e.g., '3m') */
        primaryTimeframe: rawConfig.TIMEFRAME,
        /** Higher timeframe for trend filter (e.g., '1h') */
        htfTimeframe: rawConfig.HTF_TIMEFRAME,
        /** How often to run a full market scan (milliseconds) */
        scanIntervalMs: rawConfig.SCAN_INTERVAL_MS,
        /** Send heartbeat every N cycles */
        heartBeatInterval: rawConfig.HEARTBEAT_INTERVAL,
    },

    // =========================================================================
    // STRATEGY PARAMETERS
    // =========================================================================
    strategy: {
        /** Stop-loss distance in ATR multiples (e.g., 1.5) */
        atrMultiplier: rawConfig.ATR_MULTIPLIER,
        /** Target risk:reward ratio (e.g., 3 = aim for 3R wins) */
        riskRewardTarget: rawConfig.RISK_REWARD_TARGET,
        /** Trailing stop activation (% of favorable move) */
        trailingStopPercent: rawConfig.TRAILING_STOP_PERCENT,
        /** Base position size as % of account balance */
        positionSizePercent: rawConfig.POSITION_SIZE_PERCENT,
        /** Leverage to use (e.g., 5x) */
        leverage: rawConfig.LEVERAGE,

        /** Minimum confidence score to consider a signal valid */
        confidenceThreshold: rawConfig.CONFIDENCE_THRESHOLD,
        /** Minimum ADX value to confirm trending market */
        minAdxTrend: rawConfig.MIN_ADX_TREND,
        /** Minimum Bollinger Bandwidth % to avoid flat/choppy markets */
        minBbBandwidthPct: rawConfig.MIN_BB_BANDWIDTH_PCT,
        /** Minimum average hourly volume (USD) for liquidity filter */
        minAvgVolumeUsdPerHour: rawConfig.MIN_AVG_VOLUME_USD_PER_HOUR,

        // === EXCURSION-BASED ADJUSTMENTS (MAE/MFE) ===
        /**
         * Maximum allowed average Max Adverse Excursion (%)
         * If a symbol's historical drawdown exceeds this, we skip or reduce size
         */
        maxMaePct: rawConfig.MAX_MAE_PCT,

        /**
         * Minimum MFE/MAE ratio required for confidence boost
         * Higher ratio = historically more reward than risk → more aggressive
         */
        minExcursionRatio: rawConfig.MIN_EXCURSION_RATIO,

        /**
         * Minimum recent samples to consider recent data for adjustments
         */
        minRecentSamplesForAdjustment: rawConfig.MIN_RECENT_SAMPLES_FOR_ADJUSTMENT, // Minimum recent samples to consider recent data

        /**
         * Confidence boost (0.0–1.0) when excursion ratio is strong
         * Added directly to final signal confidence
         */
        excursionConfidenceBoost: rawConfig.EXCURSION_CONFIDENCE_BOOST,

        // NEW: Regime-aware controls
        autoTradeReversalEnabled: rawConfig.AUTO_TRADE_REVERSAL_ENABLED,
        recentWindowHours: rawConfig.RECENT_WINDOW_HOURS,
        minReverseCountForAutoReversal: rawConfig.MIN_REVERSE_COUNT_FOR_AUTO_REVERSAL,
    },

    // =========================================================================
    // MACHINE LEARNING SETTINGS
    // =========================================================================
    ml: {
        labelThresholds: {
            /** R-multiple for "monster win" label (+2) */
            strongWin: rawConfig.ML_LABEL_STRONG_WIN,
            /** R-multiple for "good win" label (+1) */
            goodWin: rawConfig.ML_LABEL_GOOD_WIN,
            /** Upper bound for neutral/breakeven (0) */
            breakEven: rawConfig.ML_LABEL_BREAK_EVEN,
            /** Upper bound for small loss (-1) */
            smallLoss: rawConfig.ML_LABEL_SMALL_LOSS,
        },
        /** Minimum samples before training model */
        minSamplesToTrain: rawConfig.MIN_SAMPLES_TO_TRAIN,
        /** Path to save/load trained Random Forest model */
        modelPath: rawConfig.MODEL_PATH,
        /** Master switch for ML training */
        trainingEnabled: rawConfig.TRAINING_MODE,
    },

    // =========================================================================
    // SIMULATION ENGINE
    // =========================================================================
    simulation: {
        /** Maximum hold time for simulated trades (minutes) */
        timeoutMinutes: rawConfig.SIMULATION_TIMEOUT_MINUTES,
        /** How often to poll price during simulation (ms) */
        pollIntervalMs: rawConfig.SIMULATION_POLL_INTERVAL_MS,
        /** Fallback risk % if no ATR-based SL */
        defaultRiskPct: rawConfig.SIMULATION_DEFAULT_RISK_PCT,
        /** Partial take-profit levels (R-multiple → weight) */
        partialTpLevels: rawConfig.PARTIAL_TP_LEVELS,
    },

    // =========================================================================
    // WORKER & CONCURRENCY
    // =========================================================================
    worker: {
        /** Lock mechanism to prevent duplicate runs */
        lockType: rawConfig.LOCK_TYPE,     // 'file' or 'database'
        /** Run mode: single scan or continuous */
        scannerMode: rawConfig.SCANNER_MODE, // 'single' or 'periodic'
    },

    // =========================================================================
    // DATABASE & HISTORY
    // =========================================================================
    /** Full MySQL connection URL */
    databaseUrl: rawConfig.DATABASE_URL,

    /** Number of historical candles to keep in memory */
    historyLength: rawConfig.HISTORY_LENGTH,
};

export type Config = typeof config;
