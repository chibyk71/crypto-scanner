// Importing dependencies and modules required for the worker logic

// Handles interaction with cryptocurrency exchanges using CCXT
import { ExchangeService } from './services/exchange';

// Implements the trading strategy logic (e.g., risk-reward, indicators, feasibility)
import { Strategy } from './strategy';

// Loads runtime configuration (symbols, exchange settings, timeframe, etc.)
import { config } from './config/settings';

// The scanner that coordinates exchange data, strategy decisions, and alerting
import { MarketScanner } from './scanner-github';

// Handles sending Telegram messages (e.g., notifications about trades, errors, status)
import { TelegramService } from './services/telegram';

// Winston is a logging library for Node.js
// - `createLogger`: creates a logger instance
// - `format`: defines log formatting (e.g., JSON, timestamp)
// - `transports`: specifies where logs are sent (console, file, etc.)
import { createLogger, format, transports } from 'winston';

// Provides access to database functions (alerts, locks, etc.)
import { dbService } from './db';


// -------------------- LOGGER CONFIGURATION --------------------

// Create a logger instance for this worker.
// - `level: 'info'` means logs at "info" and higher (warn, error) will be recorded
// - `format`: logs will include timestamps and be in JSON format for structure
// - `transports`: determines where logs are written
//    1. File transport: writes logs to `logs/worker.log` (persistent storage)
//    2. Console transport: outputs logs in real time to the terminal
export const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),  // Attach timestamp to every log
        format.json()        // Convert log messages into JSON structure
    ),
    transports: [
        new transports.File({ filename: 'logs/worker.log' }), // Persistent log file
        new transports.Console() // Console output for live monitoring
    ]
});


// -------------------- WORKER ENTRY POINT --------------------

// The main function that runs a worker process
// This worker does one cycle of:
//  1. Acquire lock (to prevent multiple workers overlapping)
//  2. Initialize exchange, strategy, and Telegram service
//  3. Run a single scan with MarketScanner
//  4. Release lock (always, even on error)
export async function startWorker(): Promise<void> {

    // 1. Check the lock in the database
    // The lock ensures that only one worker runs at a time.
    // If lock is `true`, another worker is already running → skip execution
    const lock = await dbService.getLock();
    if (lock) {
        logger.warn('Bot already running, skipping execution');
        return;
    }

    // If no lock, set it to `true` → claim ownership of the worker run
    await dbService.setLock(true);

    // 2. Create service instances

    // ExchangeService:
    // - Handles fetching OHLCV data
    // - Polls exchange for updates
    // - Provides latest price & historical candles
    const exchange = new ExchangeService();

    // Strategy:
    // - Implements the trading strategy logic
    // - `new Strategy(3)` → possibly sets a risk/reward ratio or number of trades
    const strategy = new Strategy(3);

    // TelegramService:
    // - Handles sending bot updates to a Telegram channel/chat
    const telegram = new TelegramService();

    try {
        // 3. Initialize exchange with configured trading symbols
        //    - Downloads initial OHLCV data
        //    - Starts polling prices
        await exchange.initialize(config.symbols);

        // Log successful exchange initialization
        logger.info('Exchange initialized', { symbols: config.symbols });

        // Create the MarketScanner:
        // - Coordinates the strategy and exchange
        // - Runs scans over the given symbols
        // - Can notify via Telegram
        const scanner = new MarketScanner(exchange, strategy, config.symbols, telegram);

        // Execute a single scan cycle:
        // - Fetch data
        // - Run strategy on each symbol
        // - Generate alerts or actions
        await scanner.runSingleScan();

        // Log successful completion
        logger.info('Worker completed', { symbols: config.symbols });

    } catch (err) {
        // 4. Handle errors gracefully

        // Log the failure with error details
        // Winston will log an object like:
        // { level: 'error', message: 'Worker failed', error: [Error object] }
        logger.error('Worker failed', { error: err });

        // Re-throw the error so caller can see it too
        throw err;

    } finally {
        // 5. Release the lock no matter what happens
        // This ensures the system does not remain stuck
        // (important if the worker crashes or throws errors)
        await dbService.setLock(false);
    }
}
