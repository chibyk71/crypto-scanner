// src/lib/db/index.ts
// =============================================================================
// DATABASE SERVICE LAYER – DRIZZLE ORM + MYSQL2
//
// Purpose:
//   • Single source of truth for ALL database interactions
//   • Used by: MarketScanner, Strategy, MLService, TelegramBot, AutoTradeService
//   • Handles connection pooling, retries, graceful shutdown
//   • Provides type-safe CRUD methods for all tables
//   • Includes special logic for:
//       - Symbol excursion stats (MAE/MFE)
//       - Simulation lifecycle
//       - Worker locking & heartbeat
//       - ML training samples
//
// Key Design Decisions:
//   • Singleton pattern – only one instance (dbService) exists
//   • Exponential backoff on startup for Docker/DB race conditions
//   • All monetary values stored with high precision (×1e8 or ×1e4)
//   • Denormalized symbolHistory table for fast excursion reads
// =============================================================================

import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

// Import all table definitions and TypeScript types from schema
import {
    alert,
    locks,
    heartbeat,
    trades,
    simulatedTrades,
    type Alert,
    type NewAlert,
    type NewTrade,
    type SimulatedTrade,
    coolDownTable,
    ohlcvHistory,
} from './schema';

import { config } from '../config/settings';
import { createLogger } from '../logger';
import type { PartialTPLevel } from '../../types';
import type { MarketRegime } from '../strategy/regime/types';

// Re-export types for consumers
export type { EnrichedSymbolHistory } from './types';

// Domain repositories (extracted from the former god file)
import * as alertsRepo from './repositories/alerts';
import * as tradesRepo from './repositories/trades';
import * as locksRepo from './repositories/locks';
import * as cooldownRepo from './repositories/cooldown';
import * as simWrite from './repositories/simulations/writePath';
import * as simRead from './repositories/simulations/readPath';
import * as simAnalytics from './repositories/simulations/analytics';
import * as watchAlertsWrite from './repositories/watchAlerts/writePath';
import * as watchAlertsRead from './repositories/watchAlerts/readPath';

// Dedicated logger for database operations
const logger = createLogger('db');

// ===========================================================================
// FATAL CONFIG VALIDATION – Fail fast if DB URL is missing
// ===========================================================================
if (!config.databaseUrl) {
    logger.error('FATAL: DATABASE_URL is missing from config');
    throw new Error('DATABASE_URL environment variable is required');
}

/**
 * DatabaseService – Core class managing MySQL connection and all queries
 *
 * Why a class + singleton?
 *   • Allows async initialization with retries
 *   • Centralizes connection pool
 *   • Provides clean getter for Drizzle instance (throws if not ready)
 *   • Enables graceful shutdown
 */
class DatabaseService {
    private pool: mysql.Pool | null = null;
    private drizzleDb: MySql2Database<any> | null = null;

    // =========================================================================
    // INITIALIZATION – Connect to MySQL with exponential backoff retry logic
    // =========================================================================
    /**
     * Initializes the database connection with robust retry mechanism.
     *
     * Why this is important:
     *   • In containerized environments (Docker, Kubernetes), the MySQL container
     *     may start slower than the application → connection attempts often fail initially
     *   • Exponential backoff prevents overwhelming the DB and gives it time to boot
     *   • Fails fast after max retries with clear error for debugging
     *
     * Behavior:
     *   • Tries up to 3 times
     *   • Delays: 2s → 4s → 8s between attempts
     *   • Creates connection pool with sane defaults
     *   • Tests connection with simple 'SELECT 1'
     *   • Initializes Drizzle ORM with full schema
     *   • Logs success or throws on final failure
     */
    public async initialize(): Promise<void> {
        // Maximum number of connection attempts before giving up
        const maxRetries = 3;
        // Base delay for exponential backoff (in milliseconds)
        const baseDelayMs = 2000;

        // Loop through retry attempts
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Log current attempt for visibility in logs
                logger.info(`Attempting MySQL connection (attempt ${attempt}/${maxRetries})`);

                // Create MySQL connection pool using the DATABASE_URL from config
                // Pool settings:
                //   - connectionLimit: 5 → limits concurrent connections to prevent overload
                //   - waitForConnections: true → queue requests if no free connection
                //   - queueLimit: 0 → unlimited queue (no dropped requests)
                //   - timezone: '+00:00' → forces UTC to avoid timezone conversion issues
                //   - charset: 'utf8mb4' → full Unicode support (emojis, etc.)
                this.pool = mysql.createPool({
                    uri: config.databaseUrl,
                    connectionLimit: 5,
                    waitForConnections: true,
                    queueLimit: 0,
                    timezone: '+00:00',
                    charset: 'utf8mb4',
                });

                // Simple health check: execute a basic query to confirm connectivity
                await this.pool.execute('SELECT 1');

                // Initialize Drizzle ORM with the pool and full table schema
                // Schema includes all tables: alerts, trades, simulations, symbolHistory, etc.
                // logger: true only in dev → enables query logging for debugging
                this.drizzleDb = drizzle(this.pool, {
                    schema: {
                        alert,
                        locks,
                        heartbeat,
                        trades,
                        simulatedTrades,
                        coolDownTable,
                        ohlcvHistory,
                    },
                    mode: 'default',
                    logger: config.env === 'dev',
                });

                // Success! Log confirmation and exit function
                logger.info('MySQL connection established and Drizzle ORM initialized');
                logger.info(`Connected to database: ${config.databaseUrl.split('@')[1]?.split('/')[1] || 'unknown'}`);
                return; // ← Early return on success
            } catch (err: any) {
                // Log detailed error for diagnosis
                logger.error(`Database connection failed (attempt ${attempt})`, {
                    error: err.message,
                    code: err.code,
                    errno: err.errno,
                });

                // If this was the final attempt → throw fatal error
                if (attempt === maxRetries) {
                    logger.error('All connection attempts failed. Giving up.');
                    throw new Error(`Failed to connect to MySQL after ${maxRetries} attempts: ${err.message}`);
                }

                // Calculate exponential backoff delay: 2s, 4s, 8s
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                logger.warn(`Retrying in ${delay / 1000} seconds...`);

                // Wait before next attempt
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // =========================================================================
    // DRIZZLE INSTANCE GETTER – Safe access with clear error if not ready
    // =========================================================================
    /**
     * Getter for the Drizzle ORM database instance.
     *
     * Why a getter instead of direct access?
     *   • Prevents usage before initialization
     *   • Gives clear, actionable error message if called too early
     *   • Enforces proper startup order (must call initialize() first)
     *
     * Used everywhere in the app via dbService.db
     */
    public get db(): MySql2Database<any> {
        // Throw descriptive error if connection hasn't been established yet
        if (!this.drizzleDb) {
            throw new Error('Database not initialized. You must call dbService.initialize() first.');
        }
        // Return the fully initialized Drizzle instance
        return this.drizzleDb;
    }

    // =========================================================================
    // GRACEFUL SHUTDOWN – Cleanly close MySQL connection pool
    // =========================================================================
    /**
     * Closes the MySQL connection pool and cleans up resources.
     *
     * Why this method exists:
     *   • Prevents "connection leak" errors when the process exits
     *   • Ensures all pending queries are finished before shutdown
     *   • Important for clean restarts (e.g., in Docker, PM2, or during /stopbot command)
     *   • Sets internal references to null so accidental use after close throws clear errors
     *
     * Called during:
     *   • Process termination (SIGTERM/SIGINT handlers)
     *   • /stopbot Telegram command
     *   • Graceful worker restart
     */
    public async close(): Promise<void> {
        // Only attempt shutdown if a pool actually exists
        if (this.pool) {
            // pool.end() waits for all connections to be released and closes them gracefully
            await this.pool.end();
            logger.info('MySQL connection pool closed gracefully');

            // Clear references to prevent accidental usage after shutdown
            this.pool = null;
            this.drizzleDb = null;
        }
    }

    // =========================================================================
    // ALERT MANAGEMENT (delegated to repositories/alerts.ts)
    // =========================================================================
    public async getActiveAlerts(): Promise<Alert[]> {
        return alertsRepo.getActiveAlerts(this.db);
    }

    public async createAlert(alertData: NewAlert): Promise<number> {
        return alertsRepo.createAlert(this.db, alertData);
    }

    public async getAlertsBySymbol(symbol: string): Promise<Alert[]> {
        return alertsRepo.getAlertsBySymbol(this.db, symbol);
    }

    public async getAlertsById(id: number): Promise<Alert | undefined> {
        return alertsRepo.getAlertsById(this.db, id);
    }

    public async updateAlert(id: number, alertData: Partial<NewAlert>): Promise<boolean> {
        return alertsRepo.updateAlert(this.db, id, alertData);
    }

    public async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<boolean> {
        return alertsRepo.updateAlertStatus(this.db, id, status);
    }

    public async setLastAlertTime(id: number, timestamp: number): Promise<void> {
        return alertsRepo.setLastAlertTime(this.db, id, timestamp);
    }

    public async deleteAlert(id: number): Promise<boolean> {
        return alertsRepo.deleteAlert(this.db, id);
    }

    // =========================================================================
    // WATCH ALERTS
    // =========================================================================
    public async createWatchAlert(row: import('./schema').NewWatchAlertRow): Promise<number> {
        return watchAlertsWrite.createWatchAlert(this.db, row);
    }

    public async updateWatchAlertStatus(
        id: number,
        status: import('../services/watchAlerts/types').WatchAlertStatus,
        opts: {
            resolvedAt: number;
            resolvedReason: import('../services/watchAlerts/types').ResolvedReason;
            triggeredPrice?: number | null;
        }
    ): Promise<boolean> {
        return watchAlertsWrite.updateWatchAlertStatus(this.db, id, status, opts);
    }

    public async recordTrendingNotification(symbol: string, lastNotifiedAt: number): Promise<void> {
        return watchAlertsWrite.recordTrendingNotification(this.db, symbol, lastNotifiedAt);
    }

    public async getActiveWatchAlerts(): Promise<import('../services/watchAlerts/types').WatchAlert[]> {
        return watchAlertsRead.getActiveWatchAlerts(this.db);
    }

    public async countActiveWatchAlerts(): Promise<number> {
        return watchAlertsRead.countActiveWatchAlerts(this.db);
    }

    public async getWatchAlertById(id: number): Promise<import('../services/watchAlerts/types').WatchAlert | undefined> {
        return watchAlertsRead.getWatchAlertById(this.db, id);
    }

    public async getLastTrendingNotification(symbol: string): Promise<number | null> {
        return watchAlertsRead.getLastTrendingNotification(this.db, symbol);
    }


    // =========================================================================
    // TRADE LOGGING (delegated to repositories/trades.ts)
    // =========================================================================
    public async logTrade(tradeData: NewTrade): Promise<number> {
        return tradesRepo.logTrade(this.db, tradeData);
    }

    // =========================================================================
    // WORKER LOCKING & HEARTBEAT (delegated to repositories/locks.ts)
    // =========================================================================
    public async getLock(): Promise<boolean> {
        return locksRepo.getLock(this.db);
    }

    public async setLock(isLocked: boolean): Promise<void> {
        return locksRepo.setLock(this.db, isLocked);
    }

    public async getHeartbeatCount(): Promise<number> {
        return locksRepo.getHeartbeatCount(this.db);
    }

    public async incrementHeartbeatCount(): Promise<number> {
        return locksRepo.incrementHeartbeatCount(this.db);
    }

    public async resetHeartbeatCount(): Promise<void> {
        return locksRepo.resetHeartbeatCount(this.db);
    }

    // =========================================================================
    // COOLDOWN MANAGEMENT (delegated to repositories/cooldown.ts)
    // =========================================================================
    public async getCoolDown(symbol: string): Promise<{
        id: number;
        symbol: string | null;
        lastTradeAt: number;
    }> {
        return cooldownRepo.getCoolDown(this.db, symbol);
    }

    public async upsertCoolDown(symbol: string, lastTradeAt: number = Date.now()): Promise<void> {
        return cooldownRepo.upsertCoolDown(this.db, symbol, lastTradeAt);
    }

    // =========================================================================
    // SIMULATION WRITE PATH (delegated to repositories/simulations/writePath.ts)
    // =========================================================================
    public async createNewSimulation(
        signalId: string,
        symbol: string,
        side: 'buy' | 'sell',
        entryPrice: number,
        openedAt: number = Date.now(),
        features?: number[],
        confidence: number = 0,
        mlPredictedLabel?: number,
        mlPredictedConfidence?: number,
        regime?: MarketRegime,
    ): Promise<string> {
        return simWrite.createNewSimulation(this.db, signalId, symbol, side, entryPrice, openedAt, features, confidence, mlPredictedLabel, mlPredictedConfidence, regime);
    }

    public async updateCompletedSimulation(
        signalId: string,
        data: {
            stoploss?: number;
            trailingDist?: number;
            tpLevels?: PartialTPLevel[];
            closedAt: number;
            outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout';
            pnl: number;
            rMultiple: number;
            label: -2 | -1 | 0 | 1 | 2;
            maxFavorableExcursion: number;
            maxAdverseExcursion: number;
            durationMs: number;
            timeToMFEMs: number;
            timeToMAEMs: number;
            features?: number[];
            trailingTriggered?: boolean;
            trailingExitPrice?: number;
            trailingExitPnl?: number;
            trailingExitAtMs?: number;
        }
    ): Promise<boolean> {
        return simWrite.updateCompletedSimulation(this.db, signalId, data);
    }

    public async setSimulationTaken(
        signalId: string,
        taken: boolean = true,
        maxRetries: number = 5,
        retryDelayMs: number = 2000
    ): Promise<void> {
        return simWrite.setSimulationTaken(this.db, signalId, taken, maxRetries, retryDelayMs);
    }

    // =========================================================================
    // SIMULATION READ PATH (delegated to repositories/simulations/readPath.ts)
    // =========================================================================
    public async getTrainingSamples(): Promise<SimulatedTrade[]> {
        return simRead.getTrainingSamples(this.db);
    }

    public async getClosedSimulatedTrades(limit = 500): Promise<SimulatedTrade[]> {
        return simRead.getClosedSimulatedTrades(this.db, limit);
    }

    public async getLabeledSimulations(options: {
        limit?: number;
        offset?: number;
        symbol?: string;
        side?: 'buy' | 'sell';
    } = {}): Promise<SimulatedTrade[]> {
        return simRead.getLabeledSimulations(this.db, options);
    }

    public async getRecentLabeledSimulations(cutoffTime: number): Promise<SimulatedTrade[]> {
        return simRead.getRecentLabeledSimulations(this.db, cutoffTime);
    }

    // =========================================================================
    // SIMULATION ANALYTICS (delegated to repositories/simulations/analytics.ts)
    // =========================================================================
    public async getTakenSimulationStats(options: {
        symbol?: string;
        since?: number;
        minRMultiple?: number;
    } = {}): Promise<{
        totalTaken: number;
        wins: number;
        winRate: number;
        avgPnL: number;
        avgRMultiple: number;
        totalPnL: number;
        outcomes: {
            tp: number;
            partial_tp: number;
            sl: number;
            timeout: number;
        };
    }> {
        return simAnalytics.getTakenSimulationStats(this.db, options);
    }

    public async getExportableSimulations(side?: 'buy' | 'sell'): Promise<Array<{
        symbol: string;
        side: string;
        label: number;
        outcome: string | null;
        closedAt: number | null;
        features: string;
    }>> {
        return simAnalytics.getExportableSimulations(this.db, side);
    }

    public async getTakenVsTotalCount(): Promise<{
        totalSims: number;
        takenSims: number;
        takenPercentage: number;
    }> {
        return simAnalytics.getTakenVsTotalCount(this.db);
    }

    public async getTakenStatsBySymbol(
        limit: number = 20,
        since?: number
    ): Promise<Array<{
        symbol: string;
        totalTaken: number;
        winRate: number;
        avgR: number;
        totalPnL: number;
    }>> {
        return simAnalytics.getTakenStatsBySymbol(this.db, limit, since);
    }

    public async getLabelDistribution(): Promise<{ label: number; count: number }[]> {
        return simAnalytics.getLabelDistribution(this.db);
    }

    public async getSampleCount(side?: 'buy' | 'sell'): Promise<number> {
        return simAnalytics.getSampleCount(this.db, side);
    }

    public async getSimulationSummaryBySymbol(): Promise<Array<{
        symbol: string;
        total: number;
        buys: number;
        sells: number;
        wins: number;
    }>> {
        return simAnalytics.getSimulationSummaryBySymbol(this.db);
    }

    public async getTopPerformingSymbols(limit = 20) {
        return simAnalytics.getTopPerformingSymbols(this.db, limit);
    }

}

// =============================================================================
// EXPORT SINGLETON INSTANCE
// This is the only way to access the database anywhere in the app
// =============================================================================
export const dbService = new DatabaseService();

// Convenience exports for initialization and cleanup
export const initializeClient = dbService.initialize.bind(dbService);
export const closeDb = dbService.close.bind(dbService);
