import { ExchangeService } from './services/exchange';
import { Strategy } from './strategy';
import { MarketScanner } from './scanner';
import { TelegramService } from './services/telegram';
import { dbService, initializeClient, closeDb } from './db';
import { createLogger } from './logger';
import * as fs from 'fs/promises';
import { config } from './config/settings';
import { TelegramBotController } from './services/telegramBotController';
import { MLService } from './services/mlService';

/**
 * Logger instance for worker-related events and errors.
 */
const logger = createLogger('worker');

/**
 * Lock types for preventing concurrent worker executions.
 */
type LockType = 'file' | 'database';

/**
 * Configuration options for the worker.
 */
type WorkerOptions = {
    lockType?: LockType; // Locking mechanism ('file' or 'database')
    scannerMode?: 'single' | 'periodic'; // Scanner execution mode
    maxRetries?: number; // Maximum retries for initialization
};

/**
 * Path to the file-based lock.
 */
const LOCK_FILE = './worker.lock';

/**
 * Maximum retries for service initialization.
 */
const MAX_RETRIES = 3;

/**
 * Delay between retries in milliseconds.
 */
const RETRY_DELAY_MS = 2000;

/**
 * Acquires a file-based lock to prevent concurrent worker executions.
 * @returns {Promise<boolean>} True if lock acquired, false if another instance holds the lock.
 */
async function acquireFileLock(): Promise<boolean> {
    try {
        await fs.writeFile(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
        logger.info('File lock acquired', { pid: process.pid });
        return true;
    } catch (err) {
        logger.warn('Failed to acquire file lock, another instance may be running', { error: err });
        return false;
    }
}

/**
 * Releases the file-based lock.
 */
async function releaseFileLock(): Promise<void> {
    try {
        await fs.unlink(LOCK_FILE);
        logger.info('File lock released');
    } catch (err) {
        logger.warn('Failed to release file lock', { error: err });
    }
}

/**
 * Acquires a database-based lock to prevent concurrent worker executions.
 * @returns {Promise<boolean>} True if lock acquired, false if already locked.
 * @throws {Error} If database operation fails.
 */
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

/**
 * Releases the database-based lock.
 */
async function releaseDatabaseLock(): Promise<void> {
    try {
        await dbService.setLock(false);
        logger.info('Database lock released');
    } catch (err) {
        logger.warn('Failed to release database lock', { error: err });
    }
}

/**
 * Initializes the worker and starts the market scanner and Telegram bot.
 * @param options - Configuration options for lock type, scanner mode, and retries.
 * @throws {Error} If initialization fails after maximum retries.
 */
export async function startWorker(options: WorkerOptions = { lockType: 'file', scannerMode: 'periodic', maxRetries: MAX_RETRIES }): Promise<void> {
    const { lockType = 'file', scannerMode = 'periodic', maxRetries = MAX_RETRIES } = options;
    let lockAcquired = false;

    // Initialize database with retries
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await initializeClient();
            logger.info('MySQL database initialized successfully');
            break;
        } catch (err: any) {
            logger.error(`Database initialization attempt ${attempt} failed`, { error: err });
            if (attempt === maxRetries) {
                throw new Error(`Database initialization failed after ${maxRetries} retries: ${err.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    // Acquire lock
    try {
        lockAcquired = lockType === 'file' ? await acquireFileLock() : await acquireDatabaseLock();
        if (!lockAcquired) {
            logger.error('Cannot start worker: another instance is running');
            if (lockType === 'database') {
                await closeDb();
                logger.info('Database connection closed');
            }
            process.exit(1);
        }
    } catch (err: any) {
        logger.error('Lock acquisition failed', { error: err });
        if (lockType === 'database') {
            await closeDb();
        }
        throw err;
    }

    const exchange = new ExchangeService();
    const mlService = new MLService();
    const strategy = new Strategy(mlService, 3);
    const telegram = new TelegramService();
    let scanner: MarketScanner | null = null;
    let botController: TelegramBotController | null = null;

    try {
        // Initialize ExchangeService with retries
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await exchange.initialize();
                const supportedSymbols = Array.from(exchange.getSupportedSymbols());
                logger.info('Exchange initialized', { mode: exchange.isLive ? 'live' : 'testnet', symbols: supportedSymbols.length });
                break;
            } catch (err: any) {
                logger.error(`Exchange initialization attempt ${attempt} failed`, { error: err });
                if (attempt === maxRetries) {
                    throw new Error(`Exchange initialization failed after ${maxRetries} retries: ${err.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }

        // Initialize MarketScanner
        scanner = new MarketScanner(exchange, telegram, strategy, mlService, Array.from(exchange.getSupportedSymbols()), {
            mode: scannerMode,
            intervalMs: config.scanner.scanIntervalMs ?? 60_000,
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            heartbeatCycles: config.scanner.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: lockType === 'database' ? 'database' : 'memory',
        });

        // Initialize TelegramBotController
        try {
            botController = new TelegramBotController(exchange, mlService);
            logger.info('TelegramBotController initialized');
        } catch (err: any) {
            logger.error('Failed to initialize TelegramBotController', { error: err });
            throw new Error(`TelegramBotController initialization failed: ${err.message}`);
        }

        // Cleanup function for graceful shutdown
        const cleanup = async () => {
            logger.info('Shutting down worker');
            try {
                if (scanner) scanner.stop();
                if (botController) botController.stop();
                exchange.stopAll();

                if (lockType === 'file') {
                    await releaseFileLock();
                } else {
                    await releaseDatabaseLock();
                    await closeDb();
                    logger.info('Database connection closed');
                }
                // Log final heartbeat for performance monitoring
                const cycleCount = await dbService.getHeartbeatCount();
                logger.info('Worker shutdown complete', { finalCycleCount: cycleCount });
                process.exit(0);
            } catch (err: any) {
                logger.error('Error during cleanup', { error: err });
                process.exit(1);
            }
        };

        // Register shutdown handlers for periodic mode
        if (scannerMode === 'periodic') {
            process.on('SIGTERM', cleanup);
            process.on('SIGINT', cleanup);
            logger.info('Registered SIGTERM/SIGINT handlers for graceful shutdown');
        }

        // Start scanner
        try {
            await scanner.start();
            logger.info('MarketScanner started', { mode: scannerMode });
        } catch (err: any) {
            logger.error('Failed to start MarketScanner', { error: err });
            throw new Error(`MarketScanner failed to start: ${err.message}`);
        }

        // For single mode, perform cleanup after scan
        if (scannerMode === 'single') {
            await cleanup();
        }
    } catch (err) {
        logger.error('Worker failed, performing emergency cleanup', { error: err });
        try {
            if (scanner) scanner.stop();
            if (botController) botController.stop();
            exchange.stopAll();

            if (lockType === 'file') {
                await releaseFileLock();
            } else {
                await releaseDatabaseLock();
                await closeDb();
                logger.info('Database connection closed');
            }
        } catch (cleanupErr: any) {
            logger.error('Emergency cleanup failed', { error: cleanupErr });
        }
        throw err;
    }
}
