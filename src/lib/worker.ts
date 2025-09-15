import { ExchangeService } from './services/exchange';
import { Strategy } from './strategy';
import { MarketScanner } from './scanner';
import { TelegramService } from './services/telegram';
import { dbService, initializeClient, closeDb } from './db';
import { createLogger } from './logger';
import * as fs from 'fs/promises';
import { config } from './config/settings';

const logger = createLogger('worker');

type LockType = 'file' | 'database';
type WorkerOptions = {
    lockType?: LockType; // 'file' for server, 'database' for GitHub Actions
    scannerMode?: 'single' | 'periodic'; // Aligns with MarketScanner mode
};

const LOCK_FILE = './worker.lock';

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
            logger.warn('Bot already running, skipping execution');
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

export async function startWorker(options: WorkerOptions = { lockType: 'file', scannerMode: 'periodic' }): Promise<void> {
    const { lockType = 'file', scannerMode = 'periodic' } = options;

    // Initialize database connection if using database lock
    if (lockType === 'database') {
        try {
            await initializeClient();
            logger.info('MySQL database initialized successfully');
        } catch (err: any) {
            logger.error('Failed to initialize MySQL database', { error: err });
            throw new Error(`Database initialization failed: ${err.message}`);
        }
    }

    // Acquire lock based on lockType
    let lockAcquired = false;
    if (lockType === 'file') {
        lockAcquired = await acquireFileLock();
    } else {
        lockAcquired = await acquireDatabaseLock();
    }

    if (!lockAcquired) {
        logger.error('Cannot start worker: another instance is running');
        if (lockType === 'database') {
            await closeDb();
            logger.info('Database connection closed');
        }
        process.exit(1);
    }

    // Initialize services
    const exchange = new ExchangeService();
    const strategy = new Strategy(3);
    const telegram = new TelegramService();
    let scanner: MarketScanner | null = null;

    try {
        // Initialize exchange
        await exchange.initialize();
        const supportedSymbols = Array.from(exchange.getSupportedSymbols());
        logger.info('Exchange initialized', { symbols: supportedSymbols });

        // Initialize MarketScanner with unified options
        scanner = new MarketScanner(exchange, strategy, supportedSymbols, telegram, {
            mode: scannerMode,
            intervalMs: config.pollingInterval ?? 60_000,
            concurrency: 3,
            cooldownMs: 5 * 60_000,
            jitterMs: 250,
            retries: 1,
            heartbeatCycles: config.heartBeatInterval ?? 60,
            requireAtrFeasibility: true,
            cooldownBackend: lockType === 'database' ? 'database' : 'memory',
        });

        // Define cleanup function for graceful shutdown
        const cleanup = async () => {
            logger.info('Shutting down worker');
            if (scanner) scanner.stop();
            exchange.stopAll();
            if (lockType === 'file') {
                await releaseFileLock();
            } else {
                await releaseDatabaseLock();
                await closeDb();
                logger.info('Database connection closed');
            }
            process.exit(0);
        };

        // Register signal handlers for server mode
        if (scannerMode === 'periodic') {
            process.on('SIGTERM', cleanup);
            process.on('SIGINT', cleanup);
        }

        // Start the scanner
        await scanner.start();
        logger.info('MarketScanner started', { symbols: supportedSymbols });

        // If single mode, wait for completion and cleanup
        if (scannerMode === 'single') {
            await cleanup();
        }
    } catch (err) {
        logger.error('Worker failed', { error: err });
        if (scanner) scanner.stop();
        exchange.stopAll();
        if (lockType === 'file') {
            await releaseFileLock();
        } else {
            await releaseDatabaseLock();
            await closeDb();
            logger.info('Database connection closed');
        }
        throw err;
    }
}
