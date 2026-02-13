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
import { and, eq, gte, isNull, not, sql, count, desc, isNotNull } from 'drizzle-orm';

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
import type { SimulationHistoryEntry } from '../../types/signalHistory';

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
    /**
 * Upserts (insert or update) a cooldown entry for a given symbol.
 *
 * This method is the single source of truth for updating the `lastTradeAt`
 * timestamp in the cooldown table. It uses MySQL's `ON DUPLICATE KEY UPDATE`
 * syntax to handle both insert and update cases in one atomic operation.
 *
 * Key guarantees:
 *   - Atomic & race-condition safe (no double-insert or lost updates)
 *   - Works correctly even if the row doesn't exist yet
 *   - Uses current timestamp if none provided (most common usage)
 *   - Logs on error but does not throw (fail-open for cooldown)
 *
 * @param symbol     - Trading pair (e.g. 'BTC/USDT') – should already be normalized
 * @param lastTradeAt - Unix timestamp (ms) when the last trade/alert occurred
 *                     If omitted, uses Date.now()
 */
    public async upsertCoolDown(symbol: string, lastTradeAt: number = Date.now()): Promise<void> {
        try {
            // Safety: ensure we have a valid positive timestamp
            if (!Number.isFinite(lastTradeAt) || lastTradeAt <= 0) {
                logger.warn('Invalid lastTradeAt provided to upsertCoolDown – using current time', {
                    symbol,
                    received: lastTradeAt,
                    fallback: Date.now(),
                });
                lastTradeAt = Date.now();
            }

            await this.db
                .insert(coolDownTable)
                .values({
                    symbol,
                    lastTradeAt,
                })
                .onDuplicateKeyUpdate({
                    set: {
                        lastTradeAt,
                    },
                })
                .execute();

            logger.debug('Cooldown upserted successfully', {
                symbol,
                lastTradeAt: new Date(lastTradeAt).toISOString(),
            });
        } catch (err) {
            // Fail-open: log but do NOT throw
            // If DB write fails, we prefer to allow the alert/trade than block everything
            logger.error('Failed to upsert cooldown entry', {
                symbol,
                lastTradeAt: new Date(lastTradeAt).toISOString(),
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
        }
    }

    // =========================================================================
    // LABELED SIMULATIONS: Fetch all rows usable for ML training (newest first)
    // =========================================================================
    /**
     * Retrieves all simulated trades that have a computed label (i.e., ready for ML training),
     * ordered by closed time descending (most recent first).
     *
     * New reality (after removing training_samples table):
     *   - Single source of truth = simulatedTrades table
     *   - Training data = rows WHERE label IS NOT NULL
     *   - No duplication — features, label, mfe/mae, duration etc. live in one place
     *
     * Used by:
     *   • MLService.retrain() – to load full dataset for training
     *   • Debugging, analytics, or reporting commands
     *
     * Important notes:
     *   - Only closed simulations with label are returned
     *   - Features are stored as JSON → safely parsed to number[]
     *   - If features somehow stored as string (DB quirk), it's handled
     *   - Returns SimulatedTrade type (with all excursion/duration fields)
     *
     * @returns Array of SimulatedTrade objects with parsed features
     */
    public async getTrainingSamples(): Promise<SimulatedTrade[]> {
        // Query only labeled (completed + labeled) simulations, newest first
        const rows = await this.db
            .select()
            .from(simulatedTrades)
            .where(isNotNull(simulatedTrades.label))
            .orderBy(desc(simulatedTrades.closedAt))
            .execute();

        // Normalize features: ensure it's always number[] (handle DB string edge case)
        return rows.map(row => ({
            ...row,
            features: row.features
                ? (typeof row.features === 'string'
                    ? JSON.parse(row.features)
                    : Array.isArray(row.features)
                        ? row.features
                        : [])
                : [],  // fallback to empty array if missing/null
        }));
    }

    // =========================================================================
    // SIMULATED TRADES: Store a completed simulation (single atomic insert)
    // =========================================================================
    /**
     * Stores a fully completed simulated trade in the database in one operation.
     *
     * Replaces the old startSimulatedTrade + closeSimulatedTrade pattern.
     * Called once at the end of simulation when all outcome metrics are known.
     *
     * Benefits of single-call design:
     *   - Atomic: either full row or nothing (no partial/incomplete records)
     *   - One DB write instead of two
     *   - No need to track signalId across calls
     *   - Simpler caller code (simulateTrade just computes → calls this)
     *
     * @param data All required simulation data (entry + outcome + metrics)
     * @returns The generated signalId (for logging / correlation)
     */
    public async storeCompletedSimulation(
        data: {
            signalId?: string;                   // optional – if not provided, a new UUID will be generated
            symbol: string;
            side: 'buy' | 'sell';
            entryPrice: number;                 // raw float
            stopLoss?: number;
            trailingDist?: number;
            tpLevels?: { price: number; weight: number }[];
            openedAt: number;                   // Unix ms
            closedAt: number;                   // Unix ms
            outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout';
            pnl: number;                        // decimal (e.g. 0.023 = +2.3%)
            rMultiple: number;
            label: -2 | -1 | 0 | 1 | 2;
            maxFavorableExcursion: number;      // positive % (e.g. 0.015 = 1.5%)
            maxAdverseExcursion: number;        // negative % (e.g. -0.008 = -0.8%)
            durationMs: number;
            timeToMFEMs: number;
            timeToMAEMs: number;
            features?: number[];                // optional – if you want to store
        }
    ): Promise<string> {
        const signalId = data.signalId ?? crypto.randomUUID();
        // const now = Date.now();

        // Defensive guard: ensure openedAt ≤ closedAt
        if (data.openedAt > data.closedAt) {
            logger.warn('Invalid timestamps in simulation – adjusting openedAt', {
                symbol: data.symbol,
                signalId,
                openedAt: new Date(data.openedAt).toISOString(),
                closedAt: new Date(data.closedAt).toISOString(),
            });
            data.openedAt = data.closedAt;
        }

        try {
            await this.db.insert(simulatedTrades).values({
                signalId,
                symbol: data.symbol.trim().toUpperCase(),
                side: data.side,
                entryPrice: data.entryPrice,
                stopLoss: data.stopLoss,
                trailingDist: data.trailingDist,
                tpLevels: data.tpLevels,
                openedAt: data.openedAt,
                closedAt: data.closedAt,
                outcome: data.outcome,
                pnl: Math.round(data.pnl * 1e8),                           // ×1e8
                rMultiple: Math.round(data.rMultiple * 1e4),               // ×1e4
                label: data.label,
                maxFavorableExcursion: Math.round(data.maxFavorableExcursion * 1e4), // ×1e4
                maxAdverseExcursion: Math.round(data.maxAdverseExcursion * 1e4),     // ×1e4
                durationMs: data.durationMs,
                timeToMFEMs: data.timeToMFEMs,
                timeToMAEMs: data.timeToMAEMs,
                features: data.features ?? null,                           // optional
            }).execute();

            logger.info('Stored completed simulated trade', {
                signalId,
                symbol: data.symbol,
                side: data.side,
                outcome: data.outcome,
                label: data.label,
                rMultiple: data.rMultiple.toFixed(3),
                pnlPercent: (data.pnl * 100).toFixed(2) + '%',
                durationMin: (data.durationMs / 60000).toFixed(1),
                mfe: data.maxFavorableExcursion.toFixed(4) + '%',
                mae: data.maxAdverseExcursion.toFixed(4) + '%',
            });

            return signalId;
        } catch (err) {
            logger.error('Failed to store completed simulated trade', {
                symbol: data.symbol,
                signalId,
                outcome: data.outcome,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });

            throw err; // Let caller decide whether to retry or skip
        }
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

    /**
 * Fetches all simulations that have a computed label (i.e., ready for ML training).
 *
 * This is the primary method used by MLService.retrain() to load training data.
 *
 * Key features:
 *   - Filters WHERE label IS NOT NULL (only completed + labeled rows)
 *   - Orders by closedAt DESC (most recent first)
 *   - Safely parses features JSON → number[]
 *   - Optional: limit, symbol filter, offset for pagination/large datasets
 *   - Returns empty array on error (fail-safe for retrain)
 *
 * @param options Optional filters and limits
 * @returns Array of fully typed SimulatedTrade objects with parsed features
 */
    public async getLabeledSimulations(options: {
        limit?: number;          // max rows to return (default: all)
        offset?: number;         // skip first N rows (for pagination)
        symbol?: string;         // filter to one symbol only
    } = {}): Promise<SimulatedTrade[]> {
        const { limit, offset = 0, symbol } = options;

        try {
            let query = this.db
                .select()
                .from(simulatedTrades)
                .where(and(
                    isNotNull(simulatedTrades.label),
                    symbol ? eq(simulatedTrades.symbol, symbol.trim().toUpperCase()) : undefined
                ))
                .orderBy(desc(simulatedTrades.closedAt))
                .offset(offset)
                .$dynamic();

            if (limit !== undefined) {
                query = query.limit(limit);
            }

            const rows = await query.execute();

            // Safely parse features (handle string JSON from DB or already-parsed array)
            const parsedRows = rows.map(row => ({
                ...row,
                features: row.features
                    ? (typeof row.features === 'string'
                        ? JSON.parse(row.features)
                        : Array.isArray(row.features)
                            ? row.features
                            : [])
                    : [],  // fallback empty array if missing/null
            }));

            logger.debug('Fetched labeled simulations', {
                count: parsedRows.length,
                limit: limit ?? 'all',
                symbol: symbol ?? 'all',
                offset,
                sampleFeaturesLength: parsedRows[0]?.features?.length ?? 'none',
            });

            return parsedRows;

        } catch (err) {
            logger.error('Failed to fetch labeled simulations', {
                error: err instanceof Error ? err.message : String(err),
                symbol: options.symbol,
                limit: options.limit,
            });
            return []; // fail-safe: empty array so retrain can continue gracefully
        }
    }

    /**
     * Returns the count of labeled simulations for each possible label (-2 to +2).
     *
     * Returns a complete distribution (all labels present, even if count = 0).
     * Used for:
     *   • MLService status reporting (/ml_status)
     *   • Monitoring class balance (critical for model health)
     *   • Telegram /ml_performance command
     *
     * @returns Array of { label: number; count: number } with all labels -2 to +2
     */
    public async getLabelDistribution(): Promise<{ label: number; count: number }[]> {
        try {
            // Raw count per existing label
            const result = await this.db
                .select({
                    label: simulatedTrades.label,
                    count: count().as('count'),
                })
                .from(simulatedTrades)
                .where(isNotNull(simulatedTrades.label))
                .groupBy(simulatedTrades.label)
                .orderBy(simulatedTrades.label)
                .execute();

            // Initialize full distribution map with 0s for all labels
            const distributionMap = new Map<number, number>();
            for (let label = -2; label <= 2; label++) {
                distributionMap.set(label, 0);
            }

            // Fill in actual counts
            for (const row of result) {
                if (row.label !== null) {
                    distributionMap.set(row.label, Number(row.count));
                }
            }

            // Convert to sorted array
            return Array.from(distributionMap.entries())
                .map(([label, count]) => ({ label, count }))
                .sort((a, b) => a.label - b.label);

        } catch (err) {
            logger.error('Failed to compute label distribution', {
                error: err instanceof Error ? err.message : String(err),
            });

            // Fail-safe: return empty distribution with zeros
            return [
                { label: -2, count: 0 },
                { label: -1, count: 0 },
                { label: 0, count: 0 },
                { label: 1, count: 0 },
                { label: 2, count: 0 },
            ];
        }
    }

    /**
 * Returns the total number of labeled simulations ready for ML training.
 *
 * Counts rows in simulatedTrades where label IS NOT NULL.
 * Used by:
 *   • MLService.retrain() – to check if enough samples exist
 *   • MLService.getStatus() – for Telegram status reporting
 *   • Monitoring / debugging (e.g. "are we collecting enough data?")
 *
 * @returns Number of simulations with a valid label (-2 to +2)
 */
    public async getSampleCount(): Promise<number> {
        try {
            const result = await this.db
                .select({ count: count() })
                .from(simulatedTrades)
                .where(isNotNull(simulatedTrades.label))
                .execute();

            const num = result[0]?.count ?? 0;
            logger.debug('Fetched labeled sample count', { num });
            return num;
        } catch (err) {
            logger.error('Failed to get sample count', {
                error: err instanceof Error ? err.message : String(err),
            });
            return 0; // fail-safe: return 0 so retrain can gracefully skip
        }
    }

    /**
 * Aggregated summary of labeled simulations per symbol.
 *
 * Used by MLService.getSampleSummary() for Telegram reporting.
 *
 * Returns:
 *   - total: number of labeled sims
 *   - buys/sells: count by side
 *   - wins: count where label >= 1
 */
    public async getSimulationSummaryBySymbol(): Promise<Array<{
        symbol: string;
        total: number;
        buys: number;
        sells: number;
        wins: number;
    }>> {
        try {
            const rows = await this.db
                .select({
                    symbol: simulatedTrades.symbol,
                    total: count(),
                    buys: sql<number>`SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END)`,
                    sells: sql<number>`SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END)`,
                    wins: sql<number>`SUM(CASE WHEN label >= 1 THEN 1 ELSE 0 END)`,
                })
                .from(simulatedTrades)
                .where(isNotNull(simulatedTrades.label))
                .groupBy(simulatedTrades.symbol)
                .orderBy(desc(sql`total`)) // optional: most active symbols first
                .execute();

            logger.debug('Fetched simulation summary by symbol', { rowCount: rows.length });

            return rows;
        } catch (err) {
            logger.error('Failed to get simulation summary by symbol', {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    /**
 * Fetches recent labeled & closed simulations for cache warm-up on startup.
 *
 * This is the main DB query used by `excursionCache.warmUpFromDb()`.
 *
 * Filters:
 *   - label IS NOT NULL          → only simulations ready for ML/training
 *   - closedAt IS NOT NULL       → only completed simulations
 *   - closedAt >= cutoffTime     → respects recency window (default 3 hours)
 *
 * Returns newest first (DESC closedAt)
 * Safety limit: max 2000 rows (prevents loading millions of old rows on startup)
 */
    public async getRecentLabeledSimulations(cutoffTime: number): Promise<SimulatedTrade[]> {
        try {
            const MAX_ROWS = 2000; // safety limit — prevents huge queries on first run

            const rows = await this.db
                .select()
                .from(simulatedTrades)
                .where(and(
                    isNotNull(simulatedTrades.label),
                    isNotNull(simulatedTrades.closedAt),
                    gte(simulatedTrades.closedAt, cutoffTime)
                ))
                .orderBy(desc(simulatedTrades.closedAt))
                .limit(MAX_ROWS)
                .execute();

            // Safely parse features (DB may return string or already-parsed array)
            const parsed = rows.map(row => ({
                ...row,
                features: row.features
                    ? (typeof row.features === 'string'
                        ? JSON.parse(row.features)
                        : Array.isArray(row.features)
                            ? row.features
                            : [])
                    : [], // fallback: empty array
            }));

            logger.info(`Fetched recent labeled simulations for cache warm-up`, {
                count: parsed.length,
                cutoffTime: new Date(cutoffTime).toISOString(),
                maxRowsApplied: parsed.length === MAX_ROWS,
            });

            return parsed;

        } catch (err) {
            logger.error('Failed to fetch recent labeled simulations for warm-up', {
                cutoffTime: new Date(cutoffTime).toISOString(),
                error: err instanceof Error ? err.message : String(err),
            });

            // Fail-safe: return empty array so warm-up continues gracefully
            return [];
        }
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

}

// =============================================================================
// EXPORT SINGLETON INSTANCE
// This is the only way to access the database anywhere in the app
// =============================================================================
export const dbService = new DatabaseService();

// Convenience exports for initialization and cleanup
export const initializeClient = dbService.initialize.bind(dbService);
export const closeDb = dbService.close.bind(dbService);
