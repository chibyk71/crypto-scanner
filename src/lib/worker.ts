// src/lib/server/worker.js
// This file is the main entry point for the trading application. It orchestrates
// the initialization of services (ExchangeService, Strategy, TelegramService) and
// the MarketScanner, ensuring only one instance runs at a time using a lock file.
// It also handles graceful shutdown on process termination signals.

// Import required services and utilities for the trading application
import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { Strategy } from './strategy';
import { MarketScanner } from './scanner';
import * as fs from 'fs/promises';
import { createLogger } from './logger';

// Initialize a logger instance with the 'worker' label for structured logging
// to both file and console, providing traceability for debugging and monitoring
const logger = createLogger('worker');

// Define the path to the lock file used to prevent concurrent worker instances
const LOCK_FILE = './worker.lock';

/**
 * Attempts to acquire a lock by creating a lock file with the current process ID.
 * This ensures only one worker instance runs at a time, preventing resource conflicts.
 * @returns {Promise<boolean>} True if the lock is acquired, false if another instance is running
 */
async function acquireLock() {
    try {
        // Attempt to write the process ID to the lock file with 'wx' flag (exclusive write)
        // This fails if the file already exists, indicating another instance is running
        await fs.writeFile(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
        logger.info('Lock acquired', { pid: process.pid });
        return true;
    } catch (err) {
        // Log a warning if lock acquisition fails, likely due to an existing instance
        logger.warn('Failed to acquire lock, another instance may be running', { error: err });
        return false;
    }
}

/**
 * Releases the lock by deleting the lock file, allowing other worker instances
 * to start after this instance terminates.
 * @returns {Promise<void>} Resolves when the lock file is deleted or if it doesn't exist
 */
async function releaseLock() {
    try {
        // Delete the lock file to release the lock
        await fs.unlink(LOCK_FILE);
        logger.info('Lock released');
    } catch (err) {
        // Log a warning if lock release fails, but continue shutdown as it's not critical
        logger.warn('Failed to release lock', { error: err });
    }
}

/**
 * Main entry point for the trading application. Initializes services, starts the
 * MarketScanner, and sets up handlers for graceful shutdown. Uses a lock file to
 * prevent multiple instances from running concurrently.
 * @returns {Promise<void>} Resolves when the worker is fully initialized or throws on error
 */
export async function startWorker() {
    // Check for an existing lock file to prevent concurrent runs
    if (!(await acquireLock())) {
        logger.error('Cannot start worker: another instance is running');
        process.exit(1); // Exit with error code if another instance is running
    }

    // Initialize core services: ExchangeService for market data, Strategy for trading logic,
    // and TelegramService for notifications
    const exchange = new ExchangeService();
    const strategy = new Strategy(3); // Configure strategy with 3% risk-reward target
    const telegram = new TelegramService();
    // Retrieve supported symbols from ExchangeService as a Set and convert to an array
    // MarketScanner expects an array of strings, so we use Array.from to convert the Set
    const supportedSymbols = exchange.getSupportedSymbols();

    // Initialize the exchange with configured symbols from settings
    try {
        await exchange.initialize();

        logger.info('Exchange initialized', { symbols: supportedSymbols });
    } catch (err) {
        // Log initialization failure with detailed error information and release lock
        logger.error('Failed to initialize exchange', { error: err });
        await releaseLock();
        throw err; // Stop execution if exchange initialization fails
    }

    // Initialize MarketScanner with services and the array of supported symbols
    const scanner = new MarketScanner(
        exchange,
        strategy,
        supportedSymbols, // Pass the array of symbols, converted from Set
        telegram
    );

    // Define cleanup function for graceful shutdown, stopping services and releasing lock
    const cleanup = async () => {
        logger.info('Shutting down worker');
        scanner.stop(); // Stop the MarketScanner to halt scanning operations
        exchange.stopAll(); // Stop all exchange polling to prevent further API calls
        await releaseLock(); // Release the lock file to allow other instances
        process.exit(0); // Exit the process cleanly with success code
    };

    // Register cleanup handlers for SIGTERM (e.g., kill command) and SIGINT (e.g., Ctrl+C)
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Start the MarketScanner to begin monitoring markets
    try {
        scanner.start();
        logger.info('MarketScanner started', { symbols: supportedSymbols });
    } catch (err) {
        // Log failure to start scanner, perform cleanup, and rethrow the error
        logger.error('Failed to start MarketScanner', { error: err });
        await cleanup();
        throw err;
    }
}
