// src/lib/server/worker.js
// This file serves as the entry point for the trading application.
// It initializes required services (exchange, strategy, telegram) and starts the MarketScanner.
// It also handles lock management to prevent concurrent runs and ensures graceful shutdown.

// Import node-cron for scheduling (though used in scanner.js, included for completeness)
// import cron from 'node-cron';

// Import services and configuration
import { ExchangeService } from './services/exchange';
import { TelegramService } from './services/telegram';
import { Strategy } from './strategy';
import { MarketScanner } from './scanner';
import { config } from './config/settings';

// Import file system for lock file management
import * as fs from 'fs/promises';
import { createLogger } from './logger';

// Initialize logger for structured logging to file and console
export const logger = createLogger('worker'); // 'worker' label for structured logging()

const LOCK_FILE = './worker.lock'; // Path to lock file to prevent concurrent runs

/**
 * Acquires a lock by creating a file with the current process ID.
 * Prevents multiple worker instances from running simultaneously.
 * @returns True if lock acquired, false if already locked
 */
async function acquireLock(): Promise<boolean> {
    try {
        await fs.writeFile(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
        logger.info('Lock acquired', { pid: process.pid });
        return true;
    } catch (err) {
        logger.warn('Failed to acquire lock, another instance may be running', { error: err });
        return false;
    }
}

/**
 * Releases the lock by deleting the lock file.
 * Allows other worker instances to start after completion.
 */
async function releaseLock(): Promise<void> {
    try {
        await fs.unlink(LOCK_FILE);
        logger.info('Lock released');
    } catch (err) {
        logger.warn('Failed to release lock', { error: err });
    }
}

/**
 * Main entry point for the trading application.
 * Initializes services, starts the MarketScanner, and handles shutdown.
 * Ensures only one instance runs at a time using a lock file.
 */
export async function startWorker(): Promise<void> {
    // Check for existing lock to prevent concurrent runs
    if (!(await acquireLock())) {
        logger.error('Cannot start worker: another instance is running');
        process.exit(1); // Exit if locked
    }

    // Initialize services
    const exchange = new ExchangeService();
    const strategy = new Strategy(3); // 3% risk-reward target
    const telegram = new TelegramService();

    // Initialize exchange with configured symbols
    try {
        await exchange.initialize(config.symbols);
        logger.info('Exchange initialized', { symbols: config.symbols });
    } catch (err) {
        logger.error('Failed to initialize exchange', { error: err });
        await releaseLock();
        throw err; // Stop if initialization fails
    }

    // Initialize MarketScanner with services and configuration
    const scanner = new MarketScanner(
        exchange,
        strategy,
        config.symbols,
        telegram
    );

    // Set up cleanup for graceful shutdown
    const cleanup = async () => {
        logger.info('Shutting down worker');
        scanner.stop(); // Stop scanner
        exchange.stopAll(); // Stop exchange polling
        await releaseLock(); // Release lock file
        process.exit(0); // Exit cleanly
    };

    // Register cleanup for SIGTERM (kill) and SIGINT (Ctrl+C)
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Start the scanner
    try {
        scanner.start();
        logger.info('MarketScanner started', { symbols: config.symbols });
    } catch (err) {
        logger.error('Failed to start MarketScanner', { error: err });
        await cleanup();
        throw err;
    }
}
