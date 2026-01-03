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
import { and, eq, gte, isNull, not, sql, count, desc, sum } from 'drizzle-orm';

// Import all table definitions and TypeScript types from schema
import {
    alert,
    locks,
    heartbeat,
    trainingSamples,
    trades,
    simulatedTrades,
    symbolHistory,           // ← Denormalized table for fast symbol stats + excursions
    type Alert,
    type NewAlert,
    type TrainingSample,
    type NewTrainingSample,
    type NewTrade,
    type SimulatedTrade,
    type NewSimulatedTrade,
    coolDownTable,
    type NewOhlcvHistory,
    ohlcvHistory,
} from './schema';

import { config } from '../config/settings';
import { createLogger } from '../logger';
import type { SimulationHistoryEntry } from '../../types/signalHistory';
import { activeSimulationsCache } from '../services/activeSimulationsCache';

// Dedicated logger for database operations
const logger = createLogger('db');

// ===========================================================================
// ENRICHED SYMBOL HISTORY TYPE
// ===========================================================================
// Replace the old EnrichedSymbolHistory with this
export interface EnrichedSymbolHistory {
    symbol: string;
    historyJson: SimulationHistoryEntry[];

    // Recent-only aggregates (last ~3 hours)
    recentAvgR: number;
    recentWinRate: number;
    recentReverseCount: number;
    recentMae: number;           // negative or zero
    recentMfe: number;           // positive
    recentExcursionRatio: number;
    recentSampleCount: number;

    // Recent directional
    recentMfeLong: number;
    recentMaeLong: number;
    recentWinRateLong: number;
    recentReverseCountLong: number;
    recentSampleCountLong: number;

    recentMfeShort: number;
    recentMaeShort: number;
    recentWinRateShort: number;
    recentReverseCountShort: number;
    recentSampleCountShort: number;

    updatedAt: Date;
}

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
                        trainingSamples,
                        trades,
                        simulatedTrades,
                        coolDownTable,
                        symbolHistory, // ← Important for fast excursion stats
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
    // ALERT MANAGEMENT: Fetch active user-defined alerts
    // =========================================================================
    /**
     * Retrieves all currently active custom alerts from the database.
     *
     * Used by:
     *   • MarketScanner – to evaluate user-defined conditions every scan cycle
     *   • TelegramBot – to list alerts via /alerts command
     *
     * Important detail:
     *   • JSON conditions are stored as strings in MySQL → must be parsed back to objects
     *   • Drizzle returns raw rows, so we normalize the `conditions` field here
     *
     * @returns Array of Alert objects with properly parsed conditions
     */
    public async getActiveAlerts(): Promise<Alert[]> {
        // Query only alerts with status = 'active'
        const rows = await this.db
            .select()
            .from(alert)
            .where(eq(alert.status, 'active'))
            .execute();

        // Normalize: parse JSON string back into object if needed
        return rows.map(a => ({
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        }));
    }

    // =========================================================================
    // ALERT MANAGEMENT: Create a new custom alert
    // =========================================================================
    /**
     * Inserts a new user-defined alert into the database.
     *
     * Called from:
     *   • TelegramBotController – when user completes /create_alert flow
     *
     * Behavior:
     *   • Inserts full alert data (symbol, timeframe, conditions, status)
     *   • Returns the auto-generated alert ID for confirmation
     *   • Logs creation for debugging/audit
     *
     * @param alertData - Full alert data (symbol, timeframe, conditions array)
     * @returns Inserted alert's database ID
     */
    public async createAlert(alertData: NewAlert): Promise<number> {
        // Drizzle insert returns result with insertId
        const [result] = await this.db.insert(alert).values(alertData).execute();

        // Log for traceability (who created what)
        logger.debug('Created new alert', { id: result.insertId, symbol: alertData.symbol });

        // Return ID so caller can confirm success
        return result.insertId;
    }

    // =========================================================================
    // ALERT MANAGEMENT: Fetch active alerts for a specific symbol
    // =========================================================================
    /**
     * Gets all active alerts for a given trading symbol.
     *
     * Used by:
     *   • AlertEvaluatorService – to check only relevant alerts per symbol
     *   • TelegramBot – for symbol-specific alert listing
     *
     * Filters:
     *   • status = 'active'
     *   • matches exact symbol
     *
     * Same JSON parsing normalization as getActiveAlerts()
     *
     * @param symbol - Trading pair (e.g., 'BTC/USDT')
     * @returns Array of matching active alerts
     */
    public async getAlertsBySymbol(symbol: string): Promise<Alert[]> {
        // Query with combined conditions: symbol match AND active status
        const alerts = await this.db
            .select()
            .from(alert)
            .where(and(eq(alert.symbol, symbol), eq(alert.status, 'active')))
            .execute();

        // Parse stored JSON conditions back to objects
        return alerts.map(a => ({
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        }));
    }

    // =========================================================================
    // ALERT MANAGEMENT: Fetch a single alert by its database ID
    // =========================================================================
    /**
     * Retrieves a specific alert by its primary key (ID).
     *
     * Used by:
     *   • TelegramBotController – when editing or deleting an alert
     *   • AlertEvaluatorService – potentially for detailed logging
     *
     * Behavior:
     *   • Returns the full Alert object if found
     *   • Returns undefined if no alert with that ID exists
     *   • Normalizes the `conditions` field (parses JSON string if needed)
     *
     * @param id - Database primary key of the alert
     * @returns Alert object or undefined
     */
    public async getAlertsById(id: number): Promise<Alert | undefined> {
        // Query single row by ID
        const result = await this.db.select().from(alert).where(eq(alert.id, id)).execute();

        // No matching alert found
        if (result.length === 0) return undefined;

        // Extract the first (and only) row
        const a = result[0];

        // Parse stored JSON conditions back to object (MySQL stores JSON as string)
        return {
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        };
    }

    // =========================================================================
    // ALERT MANAGEMENT: Update an existing alert (partial update)
    // =========================================================================
    /**
     * Updates one or more fields of an existing alert.
     *
     * Called from:
     *   • TelegramBotController – during /edit_alert flow
     *
     * Key details:
     *   • Uses Partial<NewAlert> → only provided fields are updated
     *   • Special handling for `conditions`: if provided, it's serialized to JSON by Drizzle
     *   • If conditions are omitted, we explicitly set undefined to avoid overwriting with null
     *   • Returns true if any row was affected (success), false otherwise
     *
     * @param id - Alert ID to update
     * @param alertData - Fields to update (symbol, timeframe, conditions, etc.)
     * @returns true if update affected a row
     */
    public async updateAlert(id: number, alertData: Partial<NewAlert>): Promise<boolean> {
        // Build update set – explicitly exclude conditions from spread if not provided
        // This prevents accidentally wiping conditions when only updating symbol/timeframe
        const result = await this.db
            .update(alert)
            .set({
                ...alertData,
                conditions: alertData.conditions ? alertData.conditions : undefined
            })
            .where(eq(alert.id, id))
            .execute();

        // affectedRows > 0 means the alert existed and was updated
        return result[0].affectedRows > 0;
    }

    // =========================================================================
    // ALERT MANAGEMENT: Change alert status (triggered / canceled)
    // =========================================================================
    /**
     * Updates only the status field of an alert.
     *
     * Used by:
     *   • AlertEvaluatorService – when an alert fires (set to 'triggered')
     *   • TelegramBot – for manual cancellation
     *
     * Why separate method?
     *   • More efficient than full update
     *   • Clear intent in code and logs
     *
     * @param id - Alert ID
     * @param status - New status: 'triggered' or 'canceled'
     * @returns true if update succeeded
     */
    public async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<boolean> {
        const result = await this.db
            .update(alert)
            .set({ status })
            .where(eq(alert.id, id))
            .execute();

        return result[0].affectedRows > 0;
    }

    // =========================================================================
    // ALERT MANAGEMENT: Record when an alert last triggered
    // =========================================================================
    /**
     * Updates the `lastAlertAt` timestamp for cooldown/throttling.
     *
     * Purpose:
     *   • Prevents spam when same condition triggers repeatedly
     *   • Used in MarketScanner.checkCustomAlerts() to enforce minimum delay
     *
     * Called after:
     *   • Successful alert trigger and Telegram notification
     *
     * @param id - Alert ID
     * @param timestamp - Unix millisecond timestamp of trigger
     */
    public async setLastAlertTime(id: number, timestamp: number): Promise<void> {
        // Simple update – no return value needed (void)
        await this.db
            .update(alert)
            .set({ lastAlertAt: timestamp })
            .where(eq(alert.id, id))
            .execute();
    }

    // =========================================================================
    // ALERT MANAGEMENT: Permanently delete an alert
    // =========================================================================
    /**
     * Deletes a custom alert from the database by its ID.
     *
     * Used by:
     *   • TelegramBotController – when user confirms /delete_alert
     *
     * Behavior:
     *   • Performs a hard delete (removes row completely)
     *   • Returns true if a row was actually deleted (success)
     *   • Returns false if no alert with that ID existed
     *
     * Note:
     *   • No soft-delete (status = 'deleted') – keeps DB clean
     *   • Caller should confirm with user before calling this
     *
     * @param id - Database ID of the alert to delete
     * @returns true if deletion succeeded (row existed)
     */
    public async deleteAlert(id: number): Promise<boolean> {
        // Execute DELETE query – Drizzle returns affected row info
        const result = await this.db.delete(alert).where(eq(alert.id, id)).execute();

        // affectedRows > 0 means the alert existed and was removed
        return result[0].affectedRows > 0;
    }

    // =========================================================================
    // TRADE LOGGING: Record executed live/paper trades
    // =========================================================================
    /**
     * Logs a completed trade (live or paper) to the database.
     *
     * Called from:
     *   • MarketScanner (paper trades via simulation)
     *   • AutoTradeService (real live trades)
     *
     * Purpose:
     *   • Permanent audit trail
     *   • Performance analytics (/ml_performance)
     *   • Future backtesting or tax reporting
     *
     * Stored with high precision (amount & price ×1e8)
     *
     * @param tradeData - Full trade details (symbol, side, amount, price, timestamp, mode, orderId)
     * @returns Database ID of the inserted trade row
     */
    public async logTrade(tradeData: NewTrade): Promise<number> {
        // Insert single row and get result
        const [inserted] = await this.db.insert(trades).values(tradeData).execute();

        // Log for debugging and audit trail
        logger.debug(`Logged trade for ${tradeData.symbol}`, { id: inserted.insertId });

        // Return ID for potential future reference (e.g., linking to alerts)
        return inserted.insertId;
    }

    // =========================================================================
    // WORKER LOCKING: Check if another bot instance is running
    // =========================================================================
    /**
     * Checks whether the singleton lock row indicates the bot is currently running.
     *
     * Used by:
     *   • Worker startup – to prevent duplicate instances
     *   • /status command – to show lock state
     *
     * Design:
     *   • Single row table with fixed id=1
     *   • isLocked = true → another instance holds the lock
     *   • Returns false if row doesn't exist yet (first run)
     *
     * @returns true if locked (bot running), false if free
     */
    public async getLock(): Promise<boolean> {
        // Query the singleton lock row
        const [row] = await this.db
            .select({ isLocked: locks.isLocked })
            .from(locks)
            .where(eq(locks.id, 1))
            .execute();

        // If no row exists yet → treat as unlocked
        // Otherwise return the actual flag
        return row?.isLocked ?? false;
    }

    // =========================================================================
    // WORKER LOCKING: Acquire or release the singleton lock
    // =========================================================================
    /**
     * Sets the global bot lock state (acquire or release).
     *
     * Used by:
     *   • Worker startup – set to true
     *   • Graceful shutdown (/stopbot) – set to false
     *
     * Implementation:
     *   • UPSERT pattern via onDuplicateKeyUpdate
     *   • Ensures only one row (id=1) ever exists
     *   • Atomic – safe even if multiple instances race
     *
     * @param isLocked - true to acquire lock, false to release
     */
    public async setLock(isLocked: boolean): Promise<void> {
        // Insert or update the singleton row
        // onDuplicateKeyUpdate handles both cases atomically
        await this.db
            .insert(locks)
            .values({ id: 1, isLocked })
            .onDuplicateKeyUpdate({ set: { isLocked } })
            .execute();
    }

    // =========================================================================
    // HEARTBEAT: Get current scan cycle count
    // =========================================================================
    /**
     * Retrieves the current heartbeat cycle count from the singleton heartbeat row.
     *
     * Purpose:
     *   • Tracks how many scan cycles the bot has completed
     *   • Used for Telegram heartbeat messages (every N cycles)
     *   • Provides monitoring insight (/status command)
     *
     * Behavior:
     *   • Singleton table with fixed id=1
     *   • If row doesn't exist (first run), creates it with count=0
     *   • Returns the current count (0 if new)
     *
     * @returns Current cycle count
     */
    public async getHeartbeatCount(): Promise<number> {
        // Query the singleton heartbeat row
        const result = await this.db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();

        // First-time setup: row doesn't exist yet
        if (result.length === 0) {
            // Create initial row with zeros using UPSERT pattern
            await this.db
                .insert(heartbeat)
                .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
                .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
                .execute();
            return 0;
        }

        // Return existing count
        return result[0].cycleCount;
    }

    // =========================================================================
    // HEARTBEAT: Increment cycle count and update timestamp
    // =========================================================================
    /**
     * Increments the global scan cycle counter and updates last heartbeat time.
     *
     * Called by:
     *   • MarketScanner at the start of every full scan cycle
     *
     * Why this design?
     *   • Atomic increment via UPSERT → safe even if multiple workers race
     *   • Stores both count and timestamp for monitoring
     *   • Enables heartbeat messages and uptime calculation
     *
     * @returns The new (incremented) cycle count
     */
    public async incrementHeartbeatCount(): Promise<number> {
        // Read current value (if any)
        const [current] = await this.db
            .select({ cycleCount: heartbeat.cycleCount })
            .from(heartbeat)
            .where(eq(heartbeat.id, 1))
            .execute();

        // Calculate next count (start from 0 if no row)
        const nextCount = (current?.cycleCount ?? 0) + 1;

        // UPSERT: insert new row or update existing with new count + current timestamp
        await this.db
            .insert(heartbeat)
            .values({
                id: 1,
                cycleCount: nextCount,
                lastHeartbeatAt: Date.now(),  // Fresh timestamp for monitoring
            })
            .onDuplicateKeyUpdate({
                set: { cycleCount: nextCount, lastHeartbeatAt: Date.now() },
            })
            .execute();

        // Return the updated count for logging/use
        return nextCount;
    }

    // =========================================================================
    // HEARTBEAT: Reset cycle counter (for testing or manual reset)
    // =========================================================================
    /**
     * Resets the heartbeat counter and timestamp to zero.
     *
     * Used by:
     *   • Testing scripts
     *   • Manual reset via admin command (if added later)
     *
     * Simple UPSERT to ensure row exists and is zeroed
     */
    public async resetHeartbeatCount(): Promise<void> {
        await this.db
            .insert(heartbeat)
            .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
            .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
            .execute();
    }

    // =========================================================================
    // COOLDOWN MANAGEMENT: Get last trade/alert time for a symbol
    // =========================================================================
    /**
     * Retrieves the cooldown record for a specific symbol.
     *
     * Used by:
     *   • MarketScanner.handleTradeSignal() – to prevent signal spam
     *   • Custom alert evaluation – to throttle notifications
     *
     * Table design:
     *   • One row per symbol (unique constraint on symbol)
     *   • Stores lastTradeAt timestamp
     *
     * @param symbol - Trading pair (e.g., 'BTC/USDT')
     * @returns Cooldown row (or undefined if never traded/alerted)
     */
    public async getCoolDown(symbol: string): Promise<{
        id: number;
        symbol: string | null;
        lastTradeAt: number;
    }> {
        // Query by symbol (unique index)
        const rows = await this.db.select().from(coolDownTable).where(eq(coolDownTable.symbol, symbol)).execute();

        // Return first row (should be only one) or undefined if none
        return rows[0];
    }

    // =========================================================================
    // COOLDOWN MANAGEMENT: Upsert last trade/alert timestamp for a symbol
    // =========================================================================
    /**
     * Updates or inserts the cooldown record for a specific symbol.
     *
     * Purpose:
     *   • Prevents signal/alert spam on the same symbol
     *   • Enforces minimum delay between trades or notifications
     *   • Called after successful trade execution or alert trigger
     *
     * Implementation:
     *   • Uses MySQL UPSERT via onDuplicateKeyUpdate
     *   • Unique constraint on `symbol` column ensures one row per symbol
     *   • Only updates lastTradeAt – efficient and atomic
     *
     * @param symbol - Trading pair (e.g., 'BTC/USDT')
     * @param lastTradeAt - Unix millisecond timestamp of last action
     */
    public async upsertCoolDown(symbol: string, lastTradeAt: number): Promise<void> {
        // Insert new row or update existing one with new timestamp
        // onDuplicateKeyUpdate handles both cases safely (no race conditions)
        await this.db.insert(coolDownTable)
            .values({ symbol, lastTradeAt })
            .onDuplicateKeyUpdate({ set: { lastTradeAt } })
            .execute();
    }

    // =========================================================================
    // ML TRAINING SAMPLES: Add a new labeled sample
    // =========================================================================
    /**
     * Inserts a new training sample into the database for ML model training.
     *
     * Called from:
     *   • simulateAndTrain() after every completed simulation
     *   • Potentially live trade monitoring (future enhancement)
     *
     * What it stores:
     *   • symbol – for per-symbol performance analysis
     *   • features – normalized indicator vector (number[])
     *   • label – 5-tier outcome (-2 to +2) based on R-multiple
     *
     * @param sample - Object containing symbol, features array, and label
     * @returns Database ID of the inserted sample
     */
    public async addTrainingSample(sample: NewTrainingSample): Promise<number> {
        // Insert into trainingSamples table
        const [result] = await this.db
            .insert(trainingSamples)
            .values({
                symbol: sample.symbol,
                features: sample.features,  // Drizzle automatically JSON-stringifies arrays
                label: sample.label,
            })
            .execute();

        // Log for monitoring sample growth and debugging
        logger.debug('Added ML training sample', {
            id: result.insertId,
            symbol: sample.symbol,
            label: sample.label,
            featureCount: sample.features.length,
        });

        // Return ID (useful for advanced tracking if needed)
        return result.insertId;
    }

    // =========================================================================
    // ML TRAINING SAMPLES: Fetch all samples (newest first)
    // =========================================================================
    /**
     * Retrieves all stored training samples, ordered by insertion time (descending).
     *
     * Used by:
     *   • MLService.retrain() – to load full dataset
     *   • Debugging / analytics commands
     *
     * Important:
     *   • Features are stored as JSON in DB → must parse back to number[]
     *   • Safe handling if somehow stored as string
     *
     * @returns Array of TrainingSample objects with parsed features
     */
    public async getTrainingSamples(): Promise<TrainingSample[]> {
        // Query all rows, newest first
        const rows = await this.db
            .select()
            .from(trainingSamples)
            .orderBy(desc(trainingSamples.id))
            .execute();

        // Normalize features: ensure it's always a number[]
        return rows.map(s => ({
            ...s,
            features: typeof s.features === 'string' ? JSON.parse(s.features) : s.features,
        }));
    }

    // =========================================================================
    // ML TRAINING SAMPLES: Count total or per-symbol samples
    // =========================================================================
    /**
     * Returns the total number of training samples, or count for a specific symbol.
     *
     * Used by:
     *   • MLService – to decide when to retrain (minSamplesToTrain)
     *   • /ml_status and analytics commands
     *
     * @param symbol - Optional: if provided, count only that symbol's samples
     * @returns Number of matching samples
     */
    public async getSampleCount(symbol?: string): Promise<number> {
        if (symbol) {
            // Per-symbol count
            const [row] = await this.db
                .select({ count: count() })
                .from(trainingSamples)
                .where(eq(trainingSamples.symbol, symbol))
                .execute();
            return row.count;
        }

        // Global total count
        const [row] = await this.db.select({ count: count() }).from(trainingSamples).execute();
        return row.count;
    }

    // =========================================================================
    // ML TRAINING SAMPLES: Per-symbol performance summary
    // =========================================================================
    /**
     * Generates a summary of training samples grouped by symbol.
     *
     * Used by:
     *   • TelegramBotController – /ml_samples command
     *   • MLService diagnostics and monitoring
     *
     * What it calculates:
     *   • total: total samples for the symbol
     *   • wins: samples with label = 1 (good wins) – used for win rate
     *   • buys: same as wins (label 1 = profitable long/short)
     *   • sells: samples with label = -1 (losses)
     *
     * Note:
     *   • Current labeling treats label 1 as "win" regardless of side
     *   • This may be refined later (separate long/short performance)
     *
     * @returns Array of objects with symbol-level stats
     */
    public async getSampleSummary(): Promise<{ symbol: string; total: number; buys: number; sells: number; wins: number }[]> {
        // GROUP BY symbol and calculate aggregates using SQL functions
        const result = await this.db
            .select({
                symbol: trainingSamples.symbol,
                total: count(),  // Total samples per symbol
                wins: sum(sql`CASE WHEN ${trainingSamples.label} = 1 THEN 1 ELSE 0 END`),     // Count of good wins
                buys: sum(sql`CASE WHEN ${trainingSamples.label} = 1 THEN 1 ELSE 0 END`),     // Same as wins (current design)
                sells: sum(sql`CASE WHEN ${trainingSamples.label} = -1 THEN 1 ELSE 0 END`),   // Count of losses
            })
            .from(trainingSamples)
            .groupBy(trainingSamples.symbol)
            .execute();

        // Convert BigInt results from Drizzle to regular numbers
        return result.map(r => ({
            symbol: r.symbol,
            total: r.total,
            buys: Number(r.buys),
            sells: Number(r.sells),
            wins: Number(r.wins),
        }));
    }

    // =========================================================================
    // SIMULATED TRADES: Start a new simulation record
    // =========================================================================
    /**
     * Creates a new entry in the simulatedTrades table when a simulation begins.
     *
     * Called from:
     *   • simulateTrade() function – at the very start of simulation
     *
     * Key details:
     *   • Generates unique signalId (UUID) for tracking
     *   • Initializes all outcome fields as null/0
     *   • Stores entry price with high precision (×1e8 internally)
     *   • Logs start for debugging and monitoring
     *
     * @param trade - Partial trade data (everything except signalId and openedAt)
     * @returns Generated signalId (used to close the trade later)
     */
    public async startSimulatedTrade(trade: Omit<NewSimulatedTrade, 'signalId' | 'openedAt'>): Promise<string> {
        // Create unique identifier for this simulation
        const signalId = crypto.randomUUID();

        // Insert initial row – all result fields are null/zero
        await this.db.insert(simulatedTrades).values({
            ...trade,
            signalId,
            openedAt: Date.now(),
            outcome: null!,                     // Explicit null to satisfy TypeScript
            pnl: 0,
            rMultiple: null,
            label: null,
            maxFavorableExcursion: null,
            maxAdverseExcursion: null,
        } as any).execute();

        // Log for visibility in simulation monitoring
        logger.info('Started new simulated trade', {
            signalId,
            symbol: trade.symbol,
            side: trade.side,
            entryPrice: (Number(trade.entryPrice)).toFixed(8),
        });

        // Return ID so caller can reference it when closing
        return signalId;
    }

    // =========================================================================
    // SIMULATED TRADES: Close simulation and store final results
    // =========================================================================
    /**
     * Finalizes a simulated trade and updates the recent-only symbolHistory table.
     *
     * New behavior (recent-only regime):
     * - Adds the completed simulation to historyJson with current timestamp
     * - Prunes historyJson to only entries from the last 3 hours
     * - Recomputes ALL recent aggregates from the filtered recent simulations
     * - Supports directional long/short stats
     * - Detects strong reversals using rMultiple sign and increments counters
     * - No lifetime data is stored or updated
     * *
     * @param signalId - UUID from startSimulatedTrade()
     * @param outcome - Final outcome type
     * @param pnl - Realized PnL (as decimal, e.g., 0.023 = +2.3%)
     * @param rMultiple - Risk-multiple achieved
     * @param label - Final 5-tier ML label (-2 to +2)
     * @param maxFavorablePrice - Best price reached in favorable direction
     * @param maxAdversePrice - Worst price reached against position
     */
    public async closeSimulatedTrade(
        signalId: string,
        outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout',
        pnl: number,                  // PnL as decimal (e.g., 0.05 = +5%)
        rMultiple: number,            // R-multiple of the trade (can be null if not applicable)
        label: -2 | -1 | 0 | 1 | 2,   // ML label: -2 strong loser, -1 weak loser, 0 breakeven-ish, 1 weak winner, 2 strong winner
        maxFavorablePrice: number,    // Best price reached in favor of the trade direction
        maxAdversePrice: number       // Worst price reached against the trade direction
    ): Promise<void> {
        // Current timestamp in milliseconds
        const now = Date.now();

        // We only keep trade history from the last 3 hours for "recent" statistics
        const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
        const cutoffTime = now - THREE_HOURS_MS;

        // ===================================================================
        // 1. Fetch the original simulated trade details from the database
        // ===================================================================
        // We need entry price, side (buy/sell), symbol, and when it was opened
        const [trade] = await this.db
            .select({
                entryPrice: simulatedTrades.entryPrice,
                side: simulatedTrades.side,
                symbol: simulatedTrades.symbol,
                openedAt: simulatedTrades.openedAt,
            })
            .from(simulatedTrades)
            .where(eq(simulatedTrades.signalId, signalId))
            .execute();

        // If no trade found with this signalId, log error and exit early
        if (!trade) {
            logger.error('Cannot close simulated trade – signalId not found', { signalId });
            return;
        }

        // Determine trade direction
        const isLong = trade.side === 'buy';

        // Entry price is stored scaled by 1e8 for precision – unscale it here
        const entryPrice = Number(trade.entryPrice);

        // ===================================================================
        // 2. Calculate final MFE and MAE as percentages
        // ===================================================================
        // MFE = Max Favorable Excursion (how much the trade went in our favor)
        // MAE = Max Adverse Excursion (how much the trade went against us)
        const mfePct = isLong
            ? ((maxFavorablePrice - entryPrice) / entryPrice) * 100    // Long: higher price = favorable
            : ((entryPrice - maxFavorablePrice) / entryPrice) * 100;   // Short: lower price = favorable

        // Raw MAE percentage (always positive for now)
        const maePctRaw = isLong
            ? ((entryPrice - maxAdversePrice) / entryPrice) * 100      // Long: lower price = adverse
            : ((maxAdversePrice - entryPrice) / entryPrice) * 100;     // Short: higher price = adverse

        // By convention, MAE is stored as a negative number
        const maePctNegative = -Math.abs(maePctRaw);

        // ===================================================================
        // 3. Update the simulatedTrades row with closing information
        // ===================================================================
        await this.db
            .update(simulatedTrades)
            .set({
                closedAt: now,
                outcome,                                          // tp, partial_tp, sl, timeout
                pnl: Math.round(pnl * 1e8),                       // Store PnL scaled by 1e8
                rMultiple: rMultiple === null ? null : Math.round(rMultiple * 1e4), // Scale R by 1e4 for precision
                label,                                            // ML label
                maxFavorableExcursion: Math.round(mfePct * 1e4),   // Store MFE scaled by 1e4
                maxAdverseExcursion: Math.round(maePctNegative * 1e4), // Store negative MAE scaled
            })
            .where(eq(simulatedTrades.signalId, signalId))
            .execute();

        // Log a clear summary of the closed trade for monitoring / debugging
        logger.info('SIMULATED TRADE CLOSED – ML LABEL READY', {
            signalId,
            symbol: trade.symbol,
            side: isLong ? 'LONG' : 'SHORT',
            outcome: outcome.toUpperCase(),
            pnlPct: (pnl * 100).toFixed(2),
            rMultiple: rMultiple?.toFixed(3),
            label,
            mfePct: mfePct.toFixed(2),
            maePct: maePctNegative.toFixed(2),
        });

        // ===================================================================
        // 4. Update the rolling "recent-only" history for this symbol
        // ===================================================================
        const symbol = trade.symbol;

        // Detect if this trade was a "strong reversal"
        // Strong reversal = labeled as meaningful move (|label| >= 1) but R-multiple went opposite to expected direction
        const expectedPositiveR = isLong; // Long should have positive R, Short should have negative R
        const actualPositiveR = rMultiple > 0;
        const isStrongReversal = Math.abs(label) >= 1 && actualPositiveR !== expectedPositiveR;

        // Create a new history entry for this just-closed trade
        const newEntry: SimulationHistoryEntry = {
            timestamp: now,
            direction: trade.side,
            outcome,
            rMultiple,
            label,
            durationMs: now - trade.openedAt,         // How long the trade was open
            mfe: mfePct,
            mae: maePctNegative,
        };

        // ===================================================================
        // 5. Load existing recent history for this symbol (if any)
        // ===================================================================
        const [existing] = await this.db
            .select()
            .from(symbolHistory)
            .where(eq(symbolHistory.symbol, symbol))
            .execute();

        // Start with empty array; if we have existing history, filter to only last 3 hours
        let recentEntries: SimulationHistoryEntry[] = [];

        if (existing && Array.isArray(existing.historyJson)) {
            recentEntries = existing.historyJson.filter(
                (e: any) => typeof e.timestamp === 'number' && e.timestamp >= cutoffTime
            );
        }

        // Add the freshly closed trade
        recentEntries.push(newEntry);

        // Sort newest first (most recent at index 0)
        recentEntries.sort((a, b) => b.timestamp - a.timestamp);

        // ===================================================================
        // 6. Recalculate all aggregate statistics based on recent entries only
        // ===================================================================
        const sampleCount = recentEntries.length;
        if (sampleCount === 0) return; // Safety check (should never happen)

        // Overall recent averages
        const recentAvgR = recentEntries.reduce((sum, e) => sum + e.rMultiple, 0) / sampleCount;
        const recentWinRate = recentEntries.filter(e => e.label >= 1).length / sampleCount;

        // Count of strong reversals in recent history
        const recentReverseCount = recentEntries.filter(e => {
            const expectedPositive = e.direction === 'buy';
            const actualPositive = e.rMultiple > 0;
            return Math.abs(e.label) >= 1 && actualPositive !== expectedPositive;
        }).length;

        // Average MFE / MAE across all recent trades
        const recentMfe = recentEntries.reduce((sum, e) => sum + e.mfe, 0) / sampleCount;
        const recentMae = recentEntries.reduce((sum, e) => sum + e.mae, 0) / sampleCount;
        // Excursion ratio = how much favorable movement vs adverse (higher = better risk/reward behavior)
        const recentExcursionRatio = recentMae >= -1e-6 ? recentMfe / Math.abs(recentMae) : 999999;

        // ===================================================================
        // 7. Directional (long vs short) statistics
        // ===================================================================
        const longEntries = recentEntries.filter(e => e.direction === 'buy');
        const shortEntries = recentEntries.filter(e => e.direction === 'sell');

        // Long-specific stats
        const recentMfeLong = longEntries.length ? longEntries.reduce((s, e) => s + e.mfe, 0) / longEntries.length : 0;
        const recentMaeLong = longEntries.length ? longEntries.reduce((s, e) => s + e.mae, 0) / longEntries.length : 0;
        const recentWinRateLong = longEntries.length ? longEntries.filter(e => e.label >= 1).length / longEntries.length : 0;
        const recentReverseCountLong = longEntries.filter(e => Math.abs(e.label) >= 1 && e.rMultiple <= 0).length;
        const recentSampleCountLong = longEntries.length;

        // Short-specific stats
        const recentMfeShort = shortEntries.length ? shortEntries.reduce((s, e) => s + e.mfe, 0) / shortEntries.length : 0;
        const recentMaeShort = shortEntries.length ? shortEntries.reduce((s, e) => s + e.mae, 0) / shortEntries.length : 0;
        const recentWinRateShort = shortEntries.length ? shortEntries.filter(e => e.label >= 1).length / shortEntries.length : 0;
        const recentReverseCountShort = shortEntries.filter(e => Math.abs(e.label) >= 1 && e.rMultiple >= 0).length;
        const recentSampleCountShort = shortEntries.length;

        // ===================================================================
        // 8. Upsert the updated recent statistics back into symbolHistory table
        // ===================================================================
        const updateData = {
            historyJson: recentEntries,                     // Full array of recent entries (newest first)
            recentAvgR,
            recentWinRate,
            // Add 1 if the current trade was a strong reversal
            recentReverseCount: recentReverseCount + (isStrongReversal ? 1 : 0),
            recentMae,
            recentMfe,
            recentExcursionRatio,
            recentSampleCount: sampleCount,

            // Long directional stats
            recentMfeLong,
            recentMaeLong,
            recentWinRateLong,
            recentReverseCountLong: recentReverseCountLong + (isLong && isStrongReversal ? 1 : 0),
            recentSampleCountLong,

            // Short directional stats
            recentMfeShort,
            recentMaeShort,
            recentWinRateShort,
            recentReverseCountShort: recentReverseCountShort + (!isLong && isStrongReversal ? 1 : 0),
            recentSampleCountShort,

            updatedAt: new Date(),
        };

        // If row already exists → UPDATE, otherwise → INSERT
        if (existing) {
            await this.db
                .update(symbolHistory)
                .set(updateData)
                .where(eq(symbolHistory.symbol, symbol))
                .execute();
        } else {
            await this.db
                .insert(symbolHistory)
                .values({
                    symbol,
                    ...updateData,
                })
                .execute();
        }

        // Debug log showing key recent metrics after update
        logger.debug('Updated recent-only symbolHistory', {
            symbol,
            recentSampleCount: sampleCount,
            recentMfe: recentMfe.toFixed(2),
            recentMae: recentMae.toFixed(2),
            recentExcursionRatio: recentExcursionRatio.toFixed(2),
            recentReverseCount: recentReverseCount + (isStrongReversal ? 1 : 0),
        });
    }

    // =========================================================================
    // SYMBOL EXCURSION STATS: Fast read of pre-computed averages
    // =========================================================================
    /**
     * Retrieves pre-computed average MFE, MAE, and ratio for a symbol.
     *
     * Used heavily by:
     *   • Strategy – dynamic SL/TP and confidence adjustments
     *   • AutoTradeService – risk filtering
     *   • Telegram /excursions command
     *
     * Why denormalized?
     *   • Avoid expensive real-time AVG calculations on thousands of simulations
     *   • Updated only when simulation closes (via updateSymbolHistoryExcursions)
     *
     * @param symbol - Trading pair
     * @returns Object with avgMfe, avgMae, ratio or null if no data
     */
    // public async getSymbolExcursions(symbol: string): Promise<{ avgMfe: number; avgMae: number; ratio: number } | null> {
    //     // Single-row lookup from denormalized table
    //     const [result] = await this.db
    //         .select({
    //             avgMfe: symbolHistory.avgMfe,
    //             avgMae: symbolHistory.avgMae,
    //             ratio: symbolHistory.avgExcursionRatio,
    //         })
    //         .from(symbolHistory)
    //         .where(eq(symbolHistory.symbol, symbol))
    //         .limit(1)
    //         .execute();

    //     // Return null if symbol has no history yet
    //     return result || null;
    // }

    /**
 * NEW: Batch insert OHLCV candles into historical table.
 *
 * Uses ON DUPLICATE KEY UPDATE to skip existing candles (idempotent).
 * Fire-and-forget: logs errors but does not throw (safe for ExchangeService polling).
 *
 * @param records Array of OHLCV records from CCXT fetchOHLCV
 */
    public async batchInsertOhlcv(
        records: {
            symbol: string;
            timeframe: string;
            timestamp: number;
            open: number | string;
            high: number | string;
            low: number | string;
            close: number | string;
            volume: number | string;
        }[]
    ): Promise<void> {
        if (records.length === 0) {
            return;
        }

        try {
            // Convert to Drizzle-compatible format (decimal as string)
            const values: NewOhlcvHistory[] = records.map(r => ({
                symbol: r.symbol,
                timeframe: r.timeframe,
                timestamp: r.timestamp,
                open: r.open.toString(),
                high: r.high.toString(),
                low: r.low.toString(),
                close: r.close.toString(),
                volume: r.volume.toString(),
            }));

            // Batch upsert — efficient and safe
            await this.db
                .insert(ohlcvHistory)
                .values(values)
                .onDuplicateKeyUpdate({
                    set: {
                        open: sql`VALUES(${ohlcvHistory.open})`,
                        high: sql`VALUES(${ohlcvHistory.high})`,
                        low: sql`VALUES(${ohlcvHistory.low})`,
                        close: sql`VALUES(${ohlcvHistory.close})`,
                        volume: sql`VALUES(${ohlcvHistory.volume})`,
                    },
                });

            logger.debug(`Persisted ${values.length} OHLCV candles to history table`, {
                symbol: records[0].symbol,
                timeframe: records[0].timeframe,
                count: values.length,
            });
        } catch (err) {
            logger.error('Failed to batch insert OHLCV data', {
                count: records.length,
                symbol: records[0]?.symbol || 'unknown',
                error: err instanceof Error ? err.message : err,
            });
            // Do NOT throw — this should never break live polling or simulation
        }
    }

    // =========================================================================
    // SIMULATION QUERY HELPERS: Get currently running simulations
    // =========================================================================
    /**
     * Returns all simulated trades that are still open (not yet closed).
     *
     * Used by:
     *   • Monitoring tools or admin commands
     *   • Potential cleanup of stuck simulations
     *
     * @returns Array of open SimulatedTrade objects
     */
    public async getOpenSimulatedTrades(): Promise<SimulatedTrade[]> {
        return await this.db
            .select()
            .from(simulatedTrades)
            .where(isNull(simulatedTrades.closedAt))  // closedAt is null → still running
            .execute();
    }

    // =========================================================================
    // SIMULATION QUERY HELPERS: Get recent closed simulations
    // =========================================================================
    /**
     * Fetches the most recently closed simulated trades.
     *
     * Used for:
     *   • Debugging simulation outcomes
     *   • Performance analysis
     *   • Telegram commands showing recent results
     *
     * @param limit - Maximum number of trades to return (default 500)
     * @returns Array of closed SimulatedTrade objects, newest first
     */
    public async getClosedSimulatedTrades(limit = 500): Promise<SimulatedTrade[]> {
        return await this.db
            .select()
            .from(simulatedTrades)
            .where(not(isNull(simulatedTrades.closedAt)))     // Only completed trades
            .orderBy(desc(simulatedTrades.closedAt))         // Most recent first
            .limit(limit)
            .execute();
    }

    // =========================================================================
    // SIMULATION ANALYTICS: Overall stats by label
    // =========================================================================
    /**
     * Generates performance statistics grouped by ML label (-2 to +2).
     *
     * Used for:
     *   • Monitoring simulation quality
     *   • ML model health checks
     *   • Reporting overall win rate and average R-multiple
     *
     * Returns:
     *   • count: number of simulations per label
     *   • avgPnl: average PnL percentage
     *   • avgR: average R-multiple
     *   • winRate: % of trades with label >= 1
     */
    public async getSimulationStats() {
        return await this.db
            .select({
                label: simulatedTrades.label,
                count: count(),
                avgPnl: sql<number>`ROUND(AVG(${simulatedTrades.pnl} / 1e8), 6)`.mapWith(Number),     // PnL ×1e8 → %
                avgR: sql<number>`ROUND(AVG(${simulatedTrades.rMultiple} / 1e4), 3)`.mapWith(Number), // R ×1e4 → actual
                winRate: sql<number>`
          ROUND(
            SUM(CASE WHEN ${simulatedTrades.label} >= 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0),
            2
          )
        `.mapWith(Number),
            })
            .from(simulatedTrades)
            .where(not(isNull(simulatedTrades.closedAt)))  // Only completed simulations
            .groupBy(simulatedTrades.label)
            .orderBy(simulatedTrades.label)
            .execute();
    }

    // =========================================================================
    // SIMULATION ANALYTICS: Top performing symbols by average R-multiple
    // =========================================================================
    /**
     * Retrieves the best-performing symbols based on simulation results.
     *
     * Used for:
     *   • Identifying which symbols the strategy works best on
     *   • Monitoring and reporting (e.g., Telegram commands or dashboard)
     *   • Potential future symbol filtering or weighting
     *
     * Filters:
     *   • Only closed simulations
     *   • Only profitable outcomes (label >= 1)
     *
     * Returns:
     *   • symbol
     *   • trades: total number of winning simulations
     *   • avgR: average R-multiple (higher = better risk-adjusted return)
     *   • strongWins: number of "monster wins" (label = 2)
     *
     * Sorted by avgR descending, limited to top N (default 20)
     *
     * @param limit - Maximum number of symbols to return (default 20)
     * @returns Array of top performing symbols
     */
    public async getTopPerformingSymbols(limit = 20) {
        return await this.db
            .select({
                symbol: simulatedTrades.symbol,
                trades: count(),  // Total winning trades per symbol
                avgR: sql<number>`ROUND(AVG(${simulatedTrades.rMultiple} / 1e4), 3)`.mapWith(Number), // Convert ×1e4 back to actual R
                strongWins: sql<number>`SUM(CASE WHEN ${simulatedTrades.label} = 2 THEN 1 ELSE 0 END)`.mapWith(Number) // Count of label +2
            })
            .from(simulatedTrades)
            .where(and(
                not(isNull(simulatedTrades.closedAt)),     // Only completed simulations
                gte(simulatedTrades.label, 1)              // Only profitable ones (label 1 or 2)
            ))
            .groupBy(simulatedTrades.symbol)
            .orderBy(sql`avgR DESC`)                        // Best average R first
            .limit(limit)
            .execute();
    }

    // ===========================================================================
    // Increment recent reverse count (only for closed simulations)
    // ===========================================================================
    /**
     * Increments the recent reverse counters when a strong reversal is detected.
     * Called only from closeSimulatedTrade() after a simulation finishes.
     *
     * +1 on strong reversal (wrong direction profit/loss)
     * Safe UPSERT pattern — works even if symbol row doesn't exist yet
     *
     * @param symbol
     * @param direction 'long' or 'short'
     * @param delta +1 for reversal (default), could support -1 for decay later
     */
    public async incrementRecentReverseCount(
        symbol: string,
        direction: 'long' | 'short',
        delta: 1 | -1 = 1
    ): Promise<void> {
        const longField = 'recentReverseCountLong';
        const shortField = 'recentReverseCountShort';
        const totalField = 'recentReverseCount';

        const fieldToIncrement = direction === 'long' ? longField : shortField;

        // UPSERT: insert default row if missing, then increment
        await this.db
            .insert(symbolHistory)
            .values({
                symbol,
                // All defaults from schema will apply
            })
            .onDuplicateKeyUpdate({
                set: {
                    [fieldToIncrement]: sql`${symbolHistory[fieldToIncrement]} + ${delta}`,
                    [totalField]: sql`${symbolHistory[totalField]} + ${delta}`,
                    updatedAt: new Date(),
                },
            })
            .execute();

        logger.debug('Incremented recent reverse count', {
            symbol,
            direction,
            delta,
            field: fieldToIncrement,
        });
    }

    // ===========================================================================
    // NEW: Get full enriched history for strategy decisions
    // ===========================================================================
    /**
     * Returns the complete symbol history with all recent + directional fields.
     * Used by:
     *   - Strategy.generateSignal()
     *   - AutoTradeService.execute()
     *   - TelegramBotController for rich alerts
     */
    /**
 * Returns the full recent-only history for a symbol.
 * Used by Strategy, AutoTradeService, and Telegram alerts.
 * All data reflects only the last ~3 hours.
 */
    public async getEnrichedSymbolHistory(symbol: string): Promise<EnrichedSymbolHistory> {
        const [row] = await this.db
            .select()
            .from(symbolHistory)
            .where(eq(symbolHistory.symbol, symbol))
            .execute();

        // Default object if no row exists yet
        const defaults: EnrichedSymbolHistory = {
            symbol,
            historyJson: [],
            recentAvgR: 0,
            recentWinRate: 0,
            recentReverseCount: 0,
            recentMae: 0,
            recentMfe: 0,
            recentExcursionRatio: 0,
            recentSampleCount: 0,
            recentMfeLong: 0,
            recentMaeLong: 0,
            recentWinRateLong: 0,
            recentReverseCountLong: 0,
            recentSampleCountLong: 0,
            recentMfeShort: 0,
            recentMaeShort: 0,
            recentWinRateShort: 0,
            recentReverseCountShort: 0,
            recentSampleCountShort: 0,
            updatedAt: new Date(),
        };

        if (!row) {
            return defaults;
        }

        // Type assertion is safe because row matches the schema
        return row as EnrichedSymbolHistory;
    }

    /**
 * Returns the REAL-TIME regime for a symbol:
 * - All closed simulations from last 3 hours (accurate, from DB)
 * - PLUS all currently running simulations (live interim MFE/MAE from memory)
 *
 * This is the method your Strategy should use before generating a new signal.
 */
    public async getCurrentRegime(symbol: string): Promise<{
        mfe: number;
        mae: number;
        excursionRatio: number;
        avgR: number;
        winRate: number;
        reverseCount: number;
        sampleCount: number;
        activeCount: number; // how many sims running now
        mfeLong: number;
        maeLong: number;
        winRateLong: number;
        sampleCountLong: number;
        mfeShort: number;
        maeShort: number;
        winRateShort: number;
        sampleCountShort: number;
    }> {
        // 1. Get closed recent data
        const closedHistory = await this.getEnrichedSymbolHistory(symbol);
        const closedEntries = closedHistory.historyJson;

        // 2. Get live active simulations from memory
        const activeStates = activeSimulationsCache.getBySymbol(symbol);

        // 3. Combine into temporary entries for calculation
        const liveEntries = activeStates.map(state => ({
            mfe: state.currentMfePct,
            mae: state.currentMaePct,
            rMultiple: 0, // not meaningful yet
            label: 0,
            direction: state.direction === 'long' ? 'buy' : 'sell' as 'buy' | 'sell',
        }));

        const allMfe = [...closedEntries.map(e => e.mfe), ...liveEntries.map(e => e.mfe)];
        const allMae = [...closedEntries.map(e => e.mae), ...liveEntries.map(e => e.mae)];
        const allR = [...closedEntries.map(e => e.rMultiple), ...liveEntries.map(() => 0)];
        const allLabels = [...closedEntries.map(e => e.label), ...liveEntries.map(() => 0)];
        const allDirections = [...closedEntries.map(e => e.direction), ...liveEntries.map(e => e.direction)];

        const totalCount = allMfe.length;

        if (totalCount === 0) {
            return {
                mfe: 0,
                mae: 0,
                excursionRatio: 0,
                avgR: 0,
                winRate: 0,
                reverseCount: 0,
                sampleCount: 0,
                activeCount: 0,
                mfeLong: 0,
                maeLong: 0,
                winRateLong: 0,
                sampleCountLong: 0,
                mfeShort: 0,
                maeShort: 0,
                winRateShort: 0,
                sampleCountShort: 0,
            };
        }

        const mfe = allMfe.reduce((a, b) => a + b, 0) / totalCount;
        const mae = allMae.reduce((a, b) => a + b, 0) / totalCount;
        const avgR = allR.reduce((a, b) => a + b, 0) / totalCount;
        const winRate = allLabels.filter(l => l >= 1).length / totalCount;
        const excursionRatio = mae >= -1e-6 ? mfe / Math.abs(mae) : 999999;

        // Directional (including live)
        const longAll = allDirections.filter((_, i) => allDirections[i] === 'buy');
        const shortAll = allDirections.filter((_, i) => allDirections[i] === 'sell');

        const mfeLong = longAll.length ? longAll.reduce((s, _, i) => s + allMfe[i], 0) / longAll.length : 0;
        const maeLong = longAll.length ? longAll.reduce((s, _, i) => s + allMae[i], 0) / longAll.length : 0;
        const winRateLong = longAll.length ? longAll.filter((_, i) => allLabels[i] >= 1).length / longAll.length : 0;

        const mfeShort = shortAll.length ? shortAll.reduce((s, _, i) => s + allMfe[i], 0) / shortAll.length : 0;
        const maeShort = shortAll.length ? shortAll.reduce((s, _, i) => s + allMae[i], 0) / shortAll.length : 0;
        const winRateShort = shortAll.length ? shortAll.filter((_, i) => allLabels[i] >= 1).length / shortAll.length : 0;

        // Reverse count from closed only (live ones not finished)
        const reverseCount = closedHistory.recentReverseCount;

        return {
            mfe,
            mae,
            excursionRatio,
            avgR,
            winRate,
            reverseCount,
            sampleCount: totalCount,
            activeCount: activeStates.length,
            mfeLong,
            maeLong,
            winRateLong,
            sampleCountLong: longAll.length,
            mfeShort,
            maeShort,
            winRateShort,
            sampleCountShort: shortAll.length,
        };
    }

    // ===========================================================================
    // Periodic cleanup of stale recent stats
    // ===========================================================================
    /**
     * Resets all recent fields for symbols that have had no simulation activity
     * in the last `windowHours` (default 6 hours).
     *
     * Why this is still useful:
     *   • Prevents stale data from lingering on inactive symbols
     *   • Keeps database clean and aggregates accurate
     *   • Runs safely via cron (e.g., every hour)
     *
     * Behavior:
     *   • If updatedAt is older than cutoff → full reset of recent fields
     *   • historyJson is cleared (pruned to empty)
     *   • All counters and averages reset to 0
     *
     * @param windowHours - Inactivity threshold in hours (default 6)
     */
    public async cleanupStaleRecentStats(windowHours = 6): Promise<void> {
        const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
        const cutoffDate = new Date(cutoffMs);

        const result = await this.db
            .update(symbolHistory)
            .set({
                historyJson: [],
                recentAvgR: 0,
                recentWinRate: 0,
                recentReverseCount: 0,
                recentMae: 0,
                recentMfe: 0,
                recentExcursionRatio: 0,
                recentSampleCount: 0,

                recentMfeLong: 0,
                recentMaeLong: 0,
                recentWinRateLong: 0,
                recentReverseCountLong: 0,
                recentSampleCountLong: 0,

                recentMfeShort: 0,
                recentMaeShort: 0,
                recentWinRateShort: 0,
                recentReverseCountShort: 0,
                recentSampleCountShort: 0,

                updatedAt: new Date(), // Touch to prevent immediate re-cleanup
            })
            .where(sql`${symbolHistory.updatedAt} < ${cutoffDate}`)
            .execute();

        const affected = result[0].affectedRows;

        if (affected > 0) {
            logger.info('Cleaned up stale recent stats', {
                inactiveSymbols: affected,
                cutoffHours: windowHours,
            });
        }
    }

    // =========================================================================
    // ML TRAINING: Full label distribution across all samples
    // =========================================================================
    /**
     * Returns the count of training samples for each possible label (-2 to +2).
     *
     * Used by:
     *   • MLService status reporting
     *   • Monitoring class balance (critical for model health)
     *   • Telegram /ml_status command
     *
     * Important feature:
     *   • Ensures all 5 labels are represented, even if count = 0
     *   • Prevents missing labels in charts/reports
     *
     * @returns Array of { label: number, count: number } with all labels present
     */
    public async getLabelDistribution(): Promise<{ label: number; count: number }[]> {
        // Raw query: count per existing label
        const result = await this.db
            .select({
                label: trainingSamples.label,
                count: count().as('count'),
            })
            .from(trainingSamples)
            .groupBy(trainingSamples.label)
            .orderBy(trainingSamples.label)
            .execute();

        // Initialize map with all possible labels set to 0
        // This guarantees complete distribution even for unused labels
        const distributionMap = new Map<number, number>();
        for (let label = -2; label <= 2; label++) {
            distributionMap.set(label, 0);
        }

        // Fill in actual counts from query results
        for (const row of result) {
            if (row.label !== null) {
                distributionMap.set(row.label, row.count);
            }
        }

        // Convert map to array for clean return
        return Array.from(distributionMap.entries()).map(([label, count]) => ({
            label,
            count,
        }));
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
