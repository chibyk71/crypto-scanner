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
     * @example 'dev', 'prod', 'test'
     */
    ENV: z.enum(['dev', 'prod', 'test']).default('dev'),

    /**
     * Determines the logging verbosity level for the application.
     * @default 'info'
     * @example 'error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'
     */
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),

    /**
     * The URL for connecting to the database, required to be a valid URL.
     * @example 'postgresql://user:password@localhost:5432/dbname'
     */
    DATABASE_URL: z.string().url(),

    /**
     * The name of the exchange to interact with.
     * @default 'bybit'
     * @example 'bybit', 'binance'
     */
    EXCHANGE: z.string().default('bybit'),

    /**
     * The API key for authenticating with the exchange, if required.
     * Optional, as some exchanges may not require an API key for certain operations.
     */
    EXCHANGE_API_KEY: z.string().optional(),

    /**
     * The API secret for authenticating with the exchange, if required.
     * Optional, as some exchanges may not require an API secret for certain operations.
     */
    EXCHANGE_API_SECRET: z.string().optional(),

    /**
     * The Telegram bot token for sending notifications, if Telegram integration is used.
     * Optional, as Telegram notifications may not be required in all deployments.
     */
    TELEGRAM_BOT_TOKEN: z.string().optional(),

    /**
     * The Telegram chat ID for sending notifications, if Telegram integration is used.
     * Optional, as Telegram notifications may not be required in all deployments.
     */
    TELEGRAM_CHAT_ID: z.string().optional(),

    /**
     * A comma-separated list of trading symbols to monitor or trade.
     * The string is transformed into an array of trimmed symbol strings.
     * @default ['BTC/USDT', 'ETH/USDT']
     * @example 'BTC/USDT,ETH/USDT,XRP/USDT'
     */
    SYMBOLS: z.string().transform(str => str.split(',').map(s => s.trim())).optional().default(['BTC/USDT', 'ETH/USDT']),

    /**
     * The time interval for market data or trading operations.
     * @default '1h'
     * @example '1m', '5m', '1h', '1d'
     */
    TIMEFRAME: z.string().default('1h'),

    /**
     * The leverage to apply for trading, coerced to a number from a string if necessary.
     * @default 1
     * @example '2', '10'
     */
    LEVERAGE: z.coerce.number().default(1),

    /**
     * The number of historical data points to fetch or process.
     * Coerced to a number from a string if necessary.
     * @default 200
     * @example '100', '500'
     */
    HISTORY_LENGTH: z.coerce.number().default(200),

    /**
     * The interval (in milliseconds) for polling market data or updates.
     * Coerced to a number from a string if necessary.
     * @default 60000 (1 minute)
     * @example '30000', '120000'
     */
    POLL_INTERVAL: z.coerce.number().default(60000),

    /**
     * The interval (in seconds) for sending heartbeat signals to monitor application health.
     * Coerced to a number from a string if necessary.
     * @default 20
     * @example '10', '30'
     */
    HEARTBEAT_INTERVAL: z.coerce.number().default(20),

    /**
     * The type of locking mechanism to use for concurrency control.
     * @default 'database'
     * @example 'file', 'database'
     */
    LOCK_TYPE: z.enum(['file', 'database']).default('database'),

    /**
     * The mode in which the scanner operates for monitoring or trading.
     * @default 'periodic'
     * @example 'single', 'periodic'
     */
    SCANNER_MODE: z.enum(['single', 'periodic']).default('periodic'),

    /**
     * The port on which the API server listens.
     * Coerced to a number from a string if necessary.
     * @default 3000
     * @example '8080', '5000'
     */
    API_PORT: z.coerce.number().default(3000),
});

/**
 * Parses and validates environment variables against the `ConfigSchema`.
 * Throws a `ZodError` if validation fails, ensuring that the application does not proceed with invalid configuration.
 * The validated configuration is used to construct the exported `config` object.
 */
const validatedConfig = ConfigSchema.parse(process.env);

/**
 * The validated configuration object exported for use throughout the application.
 * This object organizes environment variables into a structured, type-safe format for easy access.
 * @example
 * ```typescript
 * import { config } from './config/settings';
 * console.log(config.env); // 'dev'
 * console.log(config.exchange.name); // 'bybit'
 * console.log(config.symbols); // ['BTC/USDT', 'ETH/USDT']
 * ```
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

    /** The time interval for market data or trading operations (e.g., '1h'). */
    timeframe: validatedConfig.TIMEFRAME,

    /** The leverage to apply for trading. */
    leverage: validatedConfig.LEVERAGE,

    /** The number of historical data points to fetch or process. */
    historyLength: validatedConfig.HISTORY_LENGTH,

    /** The polling interval in milliseconds for market data or updates. */
    pollingInterval: validatedConfig.POLL_INTERVAL,

    /** The heartbeat interval in seconds for monitoring application health. */
    heartBeatInterval: validatedConfig.HEARTBEAT_INTERVAL,

    /** The locking mechanism type for concurrency control (e.g., 'database'). */
    lockType: validatedConfig.LOCK_TYPE,

    /** The scanner mode for monitoring or trading (e.g., 'periodic'). */
    scannerMode: validatedConfig.SCANNER_MODE,

    /** The port on which the API server listens. */
    apiPort: validatedConfig.API_PORT,
};

/**
 * The TypeScript type definition for the `config` object.
 * This type is inferred from the `config` object and ensures type safety when accessing configuration properties.
 * @example
 * ```typescript
 * import { Config } from './config/settings';
 * const myConfig: Config = config;
 * ```
 */
export type Config = typeof config;
