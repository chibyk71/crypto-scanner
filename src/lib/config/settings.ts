import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

dotenvConfig();

/**
 * Schema for validating environment variables using Zod.
 * Ensures all required configuration parameters are correctly typed and provides defaults.
 * @typedef {Object} ConfigSchema
 */
const ConfigSchema = z.object({
    /** Environment mode: 'dev', 'prod', or 'test' */
    ENV: z.enum(['dev', 'prod', 'test']).default('dev'),
    /** Logging verbosity level */
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
    /** MySQL database connection URL (e.g., mysql://user:pass@localhost:3306/dbname) */
    DATABASE_URL: z.string().url(),
    /** Exchange name (e.g., 'bybit') */
    EXCHANGE: z.string().default('bybit'),
    /** API key for live trading */
    EXCHANGE_API_KEY: z.string().optional(),
    /** API secret for live trading */
    EXCHANGE_API_SECRET: z.string().optional(),
    /** Enable testnet mode (true for testnet, false for live) */
    EXCHANGE_TESTNET: z.coerce.boolean().default(false),
    /** API key for testnet trading */
    EXCHANGE_TESTNET_API_KEY: z.string().optional(),
    /** API secret for testnet trading */
    EXCHANGE_TESTNET_API_SECRET: z.string().optional(),
    /** Telegram bot token for notifications */
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    /** Telegram chat ID for sending alerts */
    TELEGRAM_CHAT_ID: z.string().optional(),
    /** Comma-separated list of trading symbols (e.g., 'BTC/USDT,ETH/USDT') */
    SYMBOLS: z.string().transform(str => str.split(',').map(s => s.trim())).optional().default(['BTC/USDT', 'ETH/USDT']),
    /** Primary timeframe for market scanning (e.g., '3m') */
    TIMEFRAME: z.string().default('3m'),
    /** Higher timeframe for analysis (e.g., '1h') */
    HTF_TIMEFRAME: z.string().default('1h'),
    /** Polling interval for market scans (milliseconds) */
    POLL_INTERVAL: z.coerce.number().default(60000),
    /** Heartbeat interval in scan cycles */
    HEARTBEAT_INTERVAL: z.coerce.number().default(60),
    /** Number of historical candles to fetch */
    HISTORY_LENGTH: z.coerce.number().default(200),
    /** Scanner mode: 'single' or 'periodic' */
    SCANNER_MODE: z.enum(['single', 'periodic']).default('periodic'),
    /** ATR multiplier for stop-loss calculation */
    ATR_MULTIPLIER: z.coerce.number().default(1.5),
    /** Target risk-reward ratio for trades */
    RISK_REWARD_TARGET: z.coerce.number().default(2),
    /** Trailing stop percentage for risk management */
    TRAILING_STOP_PERCENT: z.coerce.number().default(0.5),
    /** Leverage to apply to trades */
    LEVERAGE: z.coerce.number().default(1),
    /** Lock mechanism: 'file' or 'database' */
    LOCK_TYPE: z.enum(['file', 'database']).default('database'),
    /** Port for the API server */
    API_PORT: z.coerce.number().default(3000),
    /** Enable ML model training */
    TRAINING_MODE: z.coerce.boolean().default(false),
    /** Path to store training data (deprecated, prefer database) */
    TRAINING_DATA_PATH: z.string().default('./training_data.json'),
    /** Minimum number of samples required to train ML model */
    MIN_SAMPLES_TO_TRAIN: z.coerce.number().default(100),
    /** Path to store the Random Forest model */
    MODEL_PATH: z.string().default('./rf_model.json'),
    /** Risk percentage of account balance per trade (0.1% to 50%) */
    POSITION_SIZE_PERCENT: z.coerce.number().min(0.1).max(50).default(1),
});

/**
 * Parsed and validated configuration object.
 * Populated from environment variables with defaults where applicable.
 * @type {z.infer<typeof ConfigSchema>}
 */
const validatedConfig = ConfigSchema.parse(process.env);

/**
 * Configuration object for the trading bot.
 * @type {Config}
 */
export const config = {
    autoTrade: Boolean(validatedConfig.EXCHANGE_API_KEY && validatedConfig.EXCHANGE_API_SECRET),
    env: validatedConfig.ENV,
    log_level: validatedConfig.LOG_LEVEL,
    exchange: {
        name: validatedConfig.EXCHANGE,
        apiKey: validatedConfig.EXCHANGE_API_KEY,
        apiSecret: validatedConfig.EXCHANGE_API_SECRET,
        testnet: validatedConfig.EXCHANGE_TESTNET,
        testnetApiKey: validatedConfig.EXCHANGE_TESTNET_API_KEY,
        testnetApiSecret: validatedConfig.EXCHANGE_TESTNET_API_SECRET,
    },
    telegram: {
        token: validatedConfig.TELEGRAM_BOT_TOKEN,
        chatId: validatedConfig.TELEGRAM_CHAT_ID,
    },
    database_url: validatedConfig.DATABASE_URL,
    symbols: validatedConfig.SYMBOLS,
    leverage: validatedConfig.LEVERAGE,
    historyLength: validatedConfig.HISTORY_LENGTH,
    lockType: validatedConfig.LOCK_TYPE,
    scannerMode: validatedConfig.SCANNER_MODE,
    apiPort: validatedConfig.API_PORT,
    scanner: {
        primaryTimeframe: validatedConfig.TIMEFRAME,
        htfTimeframe: validatedConfig.HTF_TIMEFRAME,
        scanIntervalMs: validatedConfig.POLL_INTERVAL,
        heartBeatInterval: validatedConfig.HEARTBEAT_INTERVAL,
    },
    strategy: {
        atrMultiplier: validatedConfig.ATR_MULTIPLIER,
        riskRewardTarget: validatedConfig.RISK_REWARD_TARGET,
        trailingStopPercent: validatedConfig.TRAILING_STOP_PERCENT,
        positionSizePercent: validatedConfig.POSITION_SIZE_PERCENT,
    },
    trainingMode: validatedConfig.TRAINING_MODE,
    trainingDataPath: validatedConfig.TRAINING_DATA_PATH,
    minSamplesToTrain: validatedConfig.MIN_SAMPLES_TO_TRAIN,
    modelPath: validatedConfig.MODEL_PATH,
    positionSizePercent: validatedConfig.POSITION_SIZE_PERCENT,
};

/**
 * Type definition for the configuration object.
 */
export type Config = typeof config;
