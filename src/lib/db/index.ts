import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { and, eq } from 'drizzle-orm';
import { alert, locks, heartbeat, type Alert, type NewAlert } from './schema';
import { config } from '../config/settings';
import { createLogger } from '../logger';

// Initialize logger for database-related logging
const logger = createLogger('db');

/**
 * Validates that DATABASE_URL is set in the configuration.
 * - Required for MySQL connection (format: mysql://user:pass@localhost:3306/dbname).
 * - Throws an error if not set, preventing startup with invalid config.
 */
if (!config.database_url) {
    logger.error('DATABASE_URL is not set in configuration');
    throw new Error('DATABASE_URL is not set in configuration');
}

/**
 * Global variables for MySQL connection pool and Drizzle ORM instance.
 * - pool: Manages MySQL connections for efficient query handling.
 * - drizzleDb: Type-safe Drizzle ORM instance for database operations.
 * - Initialized as null, set during initializeClient().
 */
let pool: mysql.Pool | null = null;
let drizzleDb: MySql2Database<{ alert: typeof alert; locks: typeof locks; heartbeat: typeof heartbeat }> | null = null;

/**
 * Initializes the MySQL database connection using mysql2/promise.
 * - Creates a connection pool to handle multiple concurrent queries (e.g., for alerts in scanner-github.ts).
 * - Uses DATABASE_URL from config (loaded via .env or settings.ts).
 * - Tests the connection with a simple SELECT query.
 * - Initializes the Drizzle ORM instance with the schema (alert, locks, heartbeat tables).
 * - Ensures the heartbeat table has a default row (id: 1, cycleCount: 0, lastHeartbeatAt: 0).
 * - Retries up to 3 times with exponential backoff for transient errors (e.g., cPanel network issues).
 */
export async function initializeClient() {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Log the connection attempt with the DATABASE_URL for debugging
            logger.info('Attempting to connect to MySQL', { database_url: config.database_url });

            // Create a MySQL connection pool with a limit of 10 connections
            // - waitForConnections: Ensures queries wait for available connections
            // - queueLimit: 0 allows unlimited queued queries (suitable for cron jobs)
            pool = mysql.createPool({
                uri: config.database_url,
                waitForConnections: true,
                connectionLimit: 3,
                queueLimit: 0,
            });

            // Test the connection with a simple query to ensure connectivity
            const [result] = await pool.execute('SELECT 1');
            if (!result) throw new Error('Connection test failed');

            // Initialize Drizzle ORM with the schema and logging based on environment
            drizzleDb = drizzle(pool, {
                schema: { alert, locks, heartbeat },
                mode: 'default',
                logger: config.env === 'dev' ? true : false,
            });

            // Log successful initialization
            logger.info('MySQL database initialized successfully');
            return;
        } catch (err:any) {
            // Log detailed error information for debugging
            logger.error(`Database connection attempt ${i + 1} failed`, {
                error: err.message,
                database_url: config.database_url
            });
            if (i === maxRetries - 1) throw new Error(`Failed to connect to MySQL database: ${err.message}`);
            // Exponential backoff: wait longer with each retry
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

/**
 * Closes the MySQL connection pool gracefully.
 * - Called on process exit or error to release resources.
 * - Ensures no lingering connections, especially in cPanel shared hosting.
 */
export async function closeDb() {
    if (pool) {
        try {
            pool.end(); // Ensure all connections are closed
            logger.info('MySQL database connection pool closed');
        } catch (err) {
            logger.error('Failed to close database pool', { error: err });
        } finally {
            pool = null; // Prevent reuse
        }
    }
}

/**
 * Database service providing methods for managing alerts, locks, and heartbeats.
 * - Uses Drizzle ORM for type-safe, efficient queries.
 * - Handles errors and logging for debugging (e.g., in cPanel logs or local dev).
 * - Designed for use in scanner-github.ts (cron jobs) and index-github.ts.
 */
export const dbService = {
    /**
     * Creates a new alert in the 'alert' table.
     * - Used when users add alerts via the bot's interface (e.g., Telegram).
     * - Inserts alert data and returns the auto-generated ID.
     * @param alertData Data for the new alert (symbol, condition, etc.)
     * @returns The ID of the inserted alert
     */
    async createAlert(alertData: NewAlert): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const [inserted] = await drizzleDb.insert(alert).values(alertData).execute();
        return inserted.insertId;
    },

    /**
     * Fetches all active alerts from the 'alert' table.
     * - Used for global scans or admin views in scanner-github.ts.
     * - Filters by 'active' status to exclude triggered or canceled alerts.
     * @returns Array of active Alert objects
     */
    async getActiveAlerts(): Promise<Alert[]> {
        if (!drizzleDb) throw new Error('Database not initialized');
        return drizzleDb.select().from(alert).where(eq(alert.status, 'active')).execute();
    },

    /**
     * Fetches active alerts for a specific symbol (e.g., 'BTC_USDT').
     * - Used in scanner-github.ts (processDatabaseAlerts) to check conditions during scans.
     * - Filters by symbol and 'active' status for efficiency.
     * @param symbol The trading pair symbol (e.g., 'BTC_USDT')
     * @returns Array of active Alert objects for the symbol
     */
    async getAlertsBySymbol(symbol: string): Promise<Alert[]> {
        if (!drizzleDb) throw new Error('Database not initialized');
        return drizzleDb
            .select()
            .from(alert)
            .where(and(eq(alert.symbol, symbol), eq(alert.status, 'active')))
            .execute();
    },

    /**
     * Updates an alert's status to 'triggered' or 'canceled'.
     * - Used in scanner-github.ts (processDatabaseAlerts) to mark alerts after signals.
     * - Throws an error if the alert ID is not found.
     * @param id The alert ID
     * @param status The new status ('triggered' or 'canceled')
     * @returns The ID of the updated alert
     */
    async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const [updated] = await drizzleDb
            .update(alert)
            .set({ status })
            .where(eq(alert.id, id))
            .execute();
        if (!updated) throw new Error(`Alert with id ${id} not found`);
        return updated.insertId;
    },

    /**
     * Deletes an alert by ID.
     * - Used when users cancel alerts via the bot or admin interface.
     * - No return value, as it's a delete operation.
     * @param id The alert ID
     */
    async deleteAlert(id: number): Promise<void> {
        if (!drizzleDb) throw new Error('Database not initialized');
        await drizzleDb.delete(alert).where(eq(alert.id, id)).execute();
    },

    /**
     * Retrieves the latest alert timestamp per symbol for cooldown checks.
     * - Used in scanner-github.ts (processTradeSignal) to enforce cooldown periods.
     * - Aggregates the maximum lastAlertAt for each active alert by symbol.
     * @returns Record mapping symbols to their latest alert timestamp
     */
    async getLastAlertTimes(): Promise<Record<string, number>> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const result = await drizzleDb
            .select({ symbol: alert.symbol, lastAlertAt: alert.lastAlertAt })
            .from(alert)
            .where(eq(alert.status, 'active'))
            .execute();
        return result.reduce((acc, { symbol, lastAlertAt }) => {
            acc[symbol] = Math.max(acc[symbol] || 0, lastAlertAt || 0);
            return acc;
        }, {} as Record<string, number>);
    },

    /**
     * Updates the last alert timestamp for a specific alert.
     * - Used in scanner-github.ts (processDatabaseAlerts) after sending a Telegram alert.
     * - Sets lastAlertAt to enforce cooldowns between alerts.
     * @param id The alert ID
     * @param timestamp The timestamp to set
     */
    async setLastAlertTime(id: number, timestamp: number): Promise<void> {
        if (!drizzleDb) throw new Error('Database not initialized');
        await drizzleDb
            .update(alert)
            .set({ lastAlertAt: timestamp })
            .where(eq(alert.id, id))
            .execute();
    },

    /**
     * Retrieves the lock status to prevent concurrent cron job runs.
     * - Used in index-github.ts to skip overlapping scans.
     * - Returns true if locked, false otherwise.
     * @returns The lock status (true if locked)
     */
    async getLock(): Promise<boolean> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const result = await drizzleDb.select().from(locks).where(eq(locks.id, 1)).execute();
        return result.length > 0 ? result[0].isLocked! : false;
    },

    /**
     * Sets the lock status to prevent or allow concurrent runs.
     * - Used in index-github.ts to manage scan execution.
     * - Uses ON DUPLICATE KEY UPDATE for idempotency.
     * @param isLocked The lock status to set
     */
    async setLock(isLocked: boolean): Promise<void> {
        if (!drizzleDb) throw new Error('Database not initialized');
        await drizzleDb
            .insert(locks)
            .values({ id: 1, isLocked })
            .onDuplicateKeyUpdate({ set: { isLocked } })
            .execute();
    },

    /**
     * Retrieves the current heartbeat cycle count from the database.
     * - Used in scanner-github.ts to track scan cycles and send heartbeats.
     * - If no row exists, initializes a default row and returns 0.
     * @returns The current cycle count
     */
    async getHeartbeatCount(): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const result = await drizzleDb.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        if (result.length === 0) {
            logger.warn('No heartbeat row found, initializing default row');
            await drizzleDb
                .insert(heartbeat)
                .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
                .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
                .execute();
            return 0;
        }
        return result[0].cycleCount;
    },

    /**
     * Increments the heartbeat cycle count and updates the last heartbeat timestamp.
     * - Used in scanner-github.ts to track scan cycles.
     * - If no row exists after update, initializes a default row with cycleCount: 1.
     * @returns The new cycle count
     */
    async incrementHeartbeatCount(): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const result = await drizzleDb.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        if (result.length === 0) {
            logger.warn('No heartbeat row found after update, initializing default row');
            await drizzleDb
                .insert(heartbeat)
                .values({ id: 1, cycleCount: 1, lastHeartbeatAt: Date.now() })
                .onDuplicateKeyUpdate({ set: { cycleCount: 1, lastHeartbeatAt: Date.now() } })
                .execute();
            return 1;
        }
        let cycleCount = result[0].cycleCount + 1;
        await drizzleDb
            .update(heartbeat)
            .set({ cycleCount: cycleCount, lastHeartbeatAt: Date.now() })
            .where(eq(heartbeat.id, 1))
            .execute();

        return cycleCount;
    },

    /**
     * Resets the heartbeat cycle count to 0 and clears the last heartbeat timestamp.
     * - Used in scanner-github.ts when sending a heartbeat after 60 cycles.
     * @returns Void
     */
    async resetHeartbeatCount(): Promise<void> {
        if (!drizzleDb) throw new Error('Database not initialized');
        await drizzleDb
            .update(heartbeat)
            .set({ cycleCount: 0, lastHeartbeatAt: 0 })
            .where(eq(heartbeat.id, 1))
            .execute();
    }
};

/**
 * Initialize the database connection on module load.
 * - Runs at startup (e.g., when index-github.ts is executed).
 * - Exits the process if initialization fails after retries.
 */
initializeClient().catch(err => {
    logger.error('Failed to initialize MySQL database:', {
        error: err.message,
        database_url: config.database_url
    });
    process.exit(1);
});
