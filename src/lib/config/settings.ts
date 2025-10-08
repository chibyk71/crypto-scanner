// src/lib/config/settings.ts

/**
 * Loads environment variables from a `.env` file into `process.env` using the `dotenv` package.
 * This allows configuration values to be defined in a `.env` file and accessed throughout the application.
 * @see https://www.npmjs.com/package/dotenv
 */
import { config as dotenvConfig } from 'dotenv';

/**
 * Provides runtime type validation and parsing for configuration values using the `zod` library.
 * Zod is used to define a schema for environment variables and ensure they conform to expected types and constraints.
 * @see https://www.npmjs.com/package/zod
 */
import { z } from 'zod';

/**
 * Initializes the loading of environment variables from the `.env` file.
 * This function is called immediately to make environment variables available in `process.env`.
 * If the `.env` file is missing or malformed, `dotenvConfig` may log warnings but does not throw errors.
 */
dotenvConfig();

/**
 * Defines a schema for validating and parsing environment variables using Zod.
 * The schema enforces type safety and provides default values for optional fields.
 * Each property corresponds to an environment variable that configures the application's behavior.
 */
const ConfigSchema = z.object({
    /**
     * Specifies the environment in which the application is running.
     * @default 'dev'
     */
    ENV: z.enum(['dev', 'prod', 'test']).default('dev'),

    /**
     * Determines the logging verbosity level for the application.
     * @default 'info'
     */
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),

    /**
     * The URL for connecting to the database, required to be a valid URL.
     */
    DATABASE_URL: z.string().url(),

    /**
     * The name of the exchange to interact with.
     * @default 'bybit'
     */
    EXCHANGE: z.string().default('bybit'),

    /**
     * The API key for authenticating with the exchange.
     */
    EXCHANGE_API_KEY: z.string().optional(),

    /**
     * The API secret for authenticating with the exchange.
     */
    EXCHANGE_API_SECRET: z.string().optional(),

    /**
     * The Telegram bot token for sending notifications.
     */
    TELEGRAM_BOT_TOKEN: z.string().optional(),

    /**
     * The Telegram chat ID for sending notifications.
     */
    TELEGRAM_CHAT_ID: z.string().optional(),

    /**
     * A comma-separated list of trading symbols to monitor or trade.
     * @default ['BTC/USDT', 'ETH/USDT']
     */
    SYMBOLS: z.string().transform(str => str.split(',').map(s => s.trim())).optional().default(['BTC/USDT', 'ETH/USDT']),

    // --- SCANNER CONFIGURATION FIELDS ---

    /**
     * The primary timeframe for data fetching and signaling.
     * Maps to config.scanner.primaryTimeframe.
     * @default '1h'
     */
    TIMEFRAME: z.string().default('3m'),

    /**
     * The higher timeframe used for multi-timeframe analysis.
     * Maps to config.scanner.htfTimeframe.
     * @default '4h'
     */
    HTF_TIMEFRAME: z.string().default('1h'),

    /**
     * The interval (in milliseconds) for polling market data or updates.
     * Maps to config.scanner.scanIntervalMs.
     * @default 60000 (1 minute)
     */
    POLL_INTERVAL: z.coerce.number().default(60000),

    /**
     * The number of scan cycles between sending heartbeat signals.
     * Maps to config.scanner.heartBeatInterval.
     * @default 60
     */
    HEARTBEAT_INTERVAL: z.coerce.number().default(60),

    /**
     * The number of historical data points to fetch or process.
     * @default 200
     */
    HISTORY_LENGTH: z.coerce.number().default(200),

    /**
     * The mode in which the scanner operates for monitoring or trading.
     * @default 'periodic'
     */
    SCANNER_MODE: z.enum(['single', 'periodic']).default('periodic'),

    // --- STRATEGY CONFIGURATION FIELDS (New) ---

    /**
     * ATR multiplier used for calculating stop-loss distance.
     * Maps to config.strategy.atrMultiplier.
     * @default 1.5
     */
    ATR_MULTIPLIER: z.coerce.number().default(1.5),

    /**
     * Minimum risk-to-reward ratio target for trade signals.
     * Maps to config.strategy.riskRewardTarget.
     * @default 2 (1:2 R:R)
     */
    RISK_REWARD_TARGET: z.coerce.number().default(2),

    /**
     * Trailing stop distance expressed as a percentage of the price.
     * Maps to config.strategy.trailingStopPercent.
     * @default 0.5 (0.5%)
     */
    TRAILING_STOP_PERCENT: z.coerce.number().default(0.5),


    // --- APPLICATION & LEGACY FIELDS ---

    /**
     * The leverage to apply for trading.
     * @default 1
     */
    LEVERAGE: z.coerce.number().default(1),

    /**
     * The type of locking mechanism to use for concurrency control.
     * @default 'database'
     */
    LOCK_TYPE: z.enum(['file', 'database']).default('database'),

    /**
     * The port on which the API server listens.
     * @default 3000
     */
    API_PORT: z.coerce.number().default(3000),

    // Existing Backtest fields
    BACKTEST_START_DATE: z.string().default('2024-01-01'),
    BACKTEST_END_DATE: z.string().default('2025-10-05'),
    BACKTEST_TIMEFRAME: z.string().default('1h'),
    BACKTEST_SYMBOLS: z.string().transform(str => str.split(',').map(s => s.trim())).optional().default(['BTC/USDT']),
    BACKTEST_CYCLES_SKIP: z.coerce.number().default(5),
});

/**
 * Parses and validates environment variables against the `ConfigSchema`.
 * Throws a `ZodError` if validation fails.
 */
const validatedConfig = ConfigSchema.parse(process.env);

/**
 * The validated configuration object, restructured into nested objects
 * (scanner, strategy) to match the application's internal structure.
 */
export const config = {
    /** The application environment (e.g., 'dev', 'prod', 'test'). */
    env: validatedConfig.ENV,

    /** The logging verbosity level (e.g., 'info', 'debug', 'error'). */
    log_level: validatedConfig.LOG_LEVEL,

    /** Configuration for the exchange connection. */
    exchange: {
        /** The name of the exchange (e.g., 'bybit'). */
        name: validatedConfig.EXCHANGE,
        /** The API key for the exchange, if provided. */
        apiKey: validatedConfig.EXCHANGE_API_KEY,
        /** The API secret for the exchange, if provided. */
        apiSecret: validatedConfig.EXCHANGE_API_SECRET,
    },

    /** Configuration for Telegram notifications, if enabled. */
    telegram: {
        /** The Telegram bot token, if provided. */
        token: validatedConfig.TELEGRAM_BOT_TOKEN,
        /** The Telegram chat ID, if provided. */
        chatId: validatedConfig.TELEGRAM_CHAT_ID,
    },

    /** The database connection URL. */
    database_url: validatedConfig.DATABASE_URL,

    /** The list of trading symbols to monitor or trade. */
    symbols: validatedConfig.SYMBOLS,

    /** The leverage to apply for trading. */
    leverage: validatedConfig.LEVERAGE,

    /** The number of historical data points to fetch or process. */
    historyLength: validatedConfig.HISTORY_LENGTH,

    /** The locking mechanism type for concurrency control (e.g., 'database'). */
    lockType: validatedConfig.LOCK_TYPE,

    /** The scanner mode for monitoring or trading (e.g., 'periodic'). */
    scannerMode: validatedConfig.SCANNER_MODE,

    /** The port on which the API server listens. */
    apiPort: validatedConfig.API_PORT,

    // --- NEW NESTED STRUCTURES TO FIX MARKETSCANNER ERRORS ---

    /** Configuration specific to the MarketScanner class. */
    scanner: {
        /** The primary timeframe for data fetching and signaling (e.g., '1h'). */
        primaryTimeframe: validatedConfig.TIMEFRAME,
        /** The higher timeframe used for multi-timeframe analysis (e.g., '4h'). */
        htfTimeframe: validatedConfig.HTF_TIMEFRAME,
        /** The interval in milliseconds between full scan cycles. */
        scanIntervalMs: validatedConfig.POLL_INTERVAL,
        /** The number of scan cycles between sending a heartbeat notification. */
        heartBeatInterval: validatedConfig.HEARTBEAT_INTERVAL,
    },

    /** Configuration specific to the Strategy class. */
    strategy: {
        /** ATR multiplier for calculating stop-loss distance. */
        atrMultiplier: validatedConfig.ATR_MULTIPLIER,
        /** The minimum risk-to-reward ratio target (e.g., 2 for 1:2 R:R). */
        riskRewardTarget: validatedConfig.RISK_REWARD_TARGET,
        /** Trailing stop percentage distance from entry/price. */
        trailingStopPercent: validatedConfig.TRAILING_STOP_PERCENT,
    },

    backtest: {
        startDate: validatedConfig.BACKTEST_START_DATE,
        endDate: validatedConfig.BACKTEST_END_DATE,
        timeframe: validatedConfig.BACKTEST_TIMEFRAME,
        symbols: validatedConfig.BACKTEST_SYMBOLS,
        cyclesSkip: validatedConfig.BACKTEST_CYCLES_SKIP,
    },
};

/**
 * The TypeScript type definition for the `config` object.
 * This type is inferred from the `config` object and ensures type safety when accessing configuration properties.
 */
export type Config = typeof config;
