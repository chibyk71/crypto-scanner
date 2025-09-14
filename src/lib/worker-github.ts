// src/lib/worker-github.ts
// This file is the main entry point for the trading application's worker process.
// It initializes services (ExchangeService, Strategy, TelegramService, dbService)
// and runs a single scan cycle using MarketScanner. It uses a MySQL database lock
// to prevent concurrent runs and ensures graceful shutdown by releasing the lock
// and closing the database connection.

// Import required services and utilities for the trading application
import { ExchangeService } from './services/exchange';
import { Strategy } from './strategy';
import { MarketScanner } from './scanner-github';
import { TelegramService } from './services/telegram';
import { dbService, initializeClient, closeDb } from './db';
import { createLogger } from './logger';

// Initialize a logger instance with the 'cron-worker' label for structured logging
// Logs are written to both a file (logs/worker.log) and the console for real-time monitoring
const logger = createLogger('cron-worker');

/**
 * Main entry point for the trading application's worker process.
 * Initializes the MySQL database, acquires a lock, sets up services, runs a single
 * MarketScanner cycle, and releases the lock and database connection. Handles errors
 * gracefully to ensure the lock is released and resources are freed.
 * @returns {Promise<void>} Resolves when the worker completes or skips execution
 * @throws {Error} If critical initialization fails (e.g., database or exchange)
 */
export async function startWorker(): Promise<void> {
    // Explicitly initialize the MySQL database connection to ensure dbService is ready
    // This calls initializeClient() in db/index.ts, which sets up the Drizzle ORM
    // with the MySQL connection pool using config.database_url
    try {
        await initializeClient();
        logger.info('MySQL database initialized successfully');
    } catch (err: any) {
        logger.error('Failed to initialize MySQL database', { error: err });
        throw new Error(`Database initialization failed: ${err.message}`);
    }

    // Check the database lock to prevent concurrent worker instances
    // If lock is true, another worker is running, so skip execution
    let lockAcquired = false;
    try {
        const lock = await dbService.getLock();
        if (lock) {
            logger.warn('Bot already running, skipping execution');
            return;
        }

        // Acquire the lock by setting it to true in the locks table
        await dbService.setLock(true);
        lockAcquired = true;
        logger.info('Lock acquired');
    } catch (err: any) {
        logger.error('Failed to acquire lock', { error: err });
        throw new Error(`Lock acquisition failed: ${err.message}`);
    }

    // Initialize core services for trading
    const exchange = new ExchangeService();
    const strategy = new Strategy(3); // Configure strategy with 3% risk-reward target
    const telegram = new TelegramService();

    try {
        // Initialize the exchange with configured symbols (e.g., ['BTC/USDT', 'ETH/USDT'])
        // This fetches initial OHLCV data and starts polling for updates
        await exchange.initialize();

        // Convert supported symbols from Set to array for MarketScanner
        // MarketScanner expects an array of strings, so we use Array.from
        const supportedSymbols = exchange.getSupportedSymbols();

        logger.info('Exchange initialized', { symbols: supportedSymbols });

        // Initialize MarketScanner with services and supported symbols
        const scanner = new MarketScanner(exchange, strategy, supportedSymbols, telegram);

        // Run a single scan cycle to fetch data, apply strategy, and generate alerts
        await scanner.runSingleScan();
        logger.info('Worker completed', { symbols: supportedSymbols });
    } catch (err) {
        // Log any errors during execution and rethrow to ensure caller is aware
        logger.error('Worker failed', { error: err });
        throw err;
    } finally {
        // Always release the lock and close database connection, even if an error occurs
        if (lockAcquired) {
            try {
                await dbService.setLock(false);
                logger.info('Lock released');
            } catch (err) {
                logger.warn('Failed to release lock', { error: err });
            }
        }
        // Close the MySQL connection pool to release resources
        try {
            await closeDb();
            logger.info('Database connection closed');
        } catch (err) {
            logger.warn('Failed to close database connection', { error: err });
        }
    }
}
