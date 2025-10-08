import { ExchangeService } from './services/exchange';
import { Strategy } from './strategy';
import { MarketScanner } from './scanner';
import { TelegramService } from './services/telegram';
import { dbService, initializeClient, closeDb } from './db';
import { createLogger } from './logger';
import * as fs from 'fs/promises';
import { config } from './config/settings';
import { TelegramBotController } from './services/telegramBotController';

const logger = createLogger('worker');

type LockType = 'file' | 'database';
type WorkerOptions = {
    lockType?: LockType; // 'file' for server, 'database' for GitHub Actions
    scannerMode?: 'single' | 'periodic'; // Aligns with MarketScanner mode
};

const LOCK_FILE = './worker.lock';

// ----------------------------------------------------------------
// Lock Management Helpers
// ----------------------------------------------------------------

async function acquireFileLock(): Promise<boolean> {
    try {
        // 'wx' flag ensures the file is created ONLY if it doesn't already exist
        await fs.writeFile(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
        logger.info('File lock acquired', { pid: process.pid });
        return true;
    } catch (err) {
        logger.warn('Failed to acquire file lock, another instance may be running', { error: err });
        return false;
    }
}

async function releaseFileLock(): Promise<void> {
    try {
        await fs.unlink(LOCK_FILE);
        logger.info('File lock released');
    } catch (err) {
        logger.warn('Failed to release file lock', { error: err });
    }
}

async function acquireDatabaseLock(): Promise<boolean> {
    try {
        const lock = await dbService.getLock();
        if (lock) {
            logger.warn('Database lock is active, skipping execution');
            return false;
        }
        await dbService.setLock(true);
        logger.info('Database lock acquired');
        return true;
    } catch (err: any) {
        logger.error('Failed to acquire database lock', { error: err });
        throw new Error(`Database lock acquisition failed: ${err.message}`);
    }
}

async function releaseDatabaseLock(): Promise<void> {
    try {
        await dbService.setLock(false);
        logger.info('Database lock released');
    } catch (err) {
        logger.warn('Failed to release database lock', { error: err });
    }
}

// ----------------------------------------------------------------
// Main Worker Function
// ----------------------------------------------------------------

export async function startWorker(options: WorkerOptions = { lockType: 'file', scannerMode: 'periodic' }): Promise<void> {
    const { lockType = 'file', scannerMode = 'periodic' } = options;

    // 1. Initialize Database
    try {
        // Must connect DB first, regardless of lockType, as other services might need it (e.g., Alert storage)
        await initializeClient();
        logger.info('MySQL database initialized successfully');
    } catch (err: any) {
        logger.error('Failed to initialize MySQL database', { error: err });
        throw new Error(`Database initialization failed: ${err.message}`);
    }

    // 2. Acquire Lock
    let lockAcquired = false;
    if (lockType === 'file') {
        lockAcquired = await acquireFileLock();
    } else {
        lockAcquired = await acquireDatabaseLock();
    }

    if (!lockAcquired) {
        logger.error('Cannot start worker: another instance is running');
        // If DB lock failed, the DB connection is still open and must be closed.
        if (lockType === 'database') {
            await closeDb();
            logger.info('Database connection closed');
        }
        process.exit(1);
    }

    // 3. Initialize Services and Run
    const exchange = new ExchangeService();
    const strategy = new Strategy(3);
    const telegram = new TelegramService();
    let scanner: MarketScanner | null = null;
    let botController: TelegramBotController | null = null;

    try {
        await exchange.initialize();
        const supportedSymbols = Array.from(exchange.getSupportedSymbols());
        logger.info('Exchange initialized', { symbols: supportedSymbols.length });

        // Initialize MarketScanner
        scanner = new MarketScanner(exchange, telegram, strategy, supportedSymbols, {
            mode: scannerMode,
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            // Use database for cooldown storage if we are using the DB lock, else use memory
            cooldownBackend: lockType === 'database' ? 'database' : 'memory',
        });

        // Initialize TelegramBotController for user interaction
        botController = new TelegramBotController(exchange);
        logger.info('TelegramBotController initialized');

        /**
         * Graceful shutdown function, ensuring all resources are properly released.
         * This logic is critical and correctly stops services, releases locks, and closes the DB.
         */
        const cleanup = async () => {
            logger.info('Shutting down worker');
            if (scanner) scanner.stop();
            if (botController) botController.stop();
            exchange.stopAll();

            if (lockType === 'file') {
                await releaseFileLock();
            } else {
                await releaseDatabaseLock();
                // Database is only closed here because we are sure to release the lock first.
                await closeDb();
                logger.info('Database connection closed');
            }
            process.exit(0);
        };

        // Register signal handlers for periodic server mode
        if (scannerMode === 'periodic') {
            process.on('SIGTERM', cleanup);
            process.on('SIGINT', cleanup);
            logger.info('Registered SIGTERM/SIGINT handlers for graceful shutdown.');
        }

        // Start the scanner
        await scanner.start();
        logger.info('MarketScanner started');

        // If single mode, wait for completion and cleanup
        if (scannerMode === 'single') {
            // MarketScanner's start() returns once the single scan is complete in this mode
            await cleanup();
        }
    } catch (err) {
        // 4. Error Handling & Cleanup
        logger.error('Worker failed, performing emergency cleanup', { error: err });

        // Stop all active components
        if (scanner) scanner.stop();
        if (botController) botController.stop();
        exchange.stopAll();

        // Release the lock and close DB before re-throwing the error
        if (lockType === 'file') {
            await releaseFileLock();
        } else {
            await releaseDatabaseLock();
            await closeDb();
            logger.info('Database connection closed');
        }
        throw err; // Re-throw the error to terminate the process cleanly and signal failure
    }
}
