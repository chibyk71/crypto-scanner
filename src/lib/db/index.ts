import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { and, eq, sql } from 'drizzle-orm';
import { alert, heartbeat, locks, type Alert, type NewAlert } from './schema';
import { config } from '../config/settings';
import { createLogger } from '../logger';

const logger = createLogger('db');

/**
 * Initializes the MySQL database connection using mysql2/promise.
 * - Uses the DATABASE_URL environment variable (e.g., 'mysql://user:pass@localhost:3306/dbname').
 * - Supports connection pooling for efficient query handling in cron jobs (discrete 5-minute runs).
 * - Retries up to 3 times with exponential backoff for transient errors (e.g., cPanel network issues).
 * - Once connected, creates the Drizzle ORM instance with the schema (alert and locks tables).
 */
if (!config.database_url) throw new Error('DATABASE_URL is not set in .env');

let pool: mysql.Pool | null = null;
// Drizzle instance typed with schema
let drizzleDb: MySql2Database<{ alert: typeof alert; locks: typeof locks, heartbeat: typeof heartbeat }> | null = null;

export async function initializeClient() {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Create a MySQL connection pool using the DATABASE_URL (cPanel format: mysql://user:pass@localhost:3306/dbname).
            // Pooling allows multiple concurrent queries (e.g., for alerts in scanner-github.ts) without overhead.
            pool = mysql.createPool({
                uri: config.database_url,
                waitForConnections: true,
                connectionLimit: 10, // Max connections (low for shared hosting limits).
                queueLimit: 0,
            });

            // Test the connection with a simple query.
            const [result] = await pool.execute('SELECT 1');
            if (!result) throw new Error('Connection test failed');

            // Initialize Drizzle ORM with the pool and schema (alert and locks tables).
            drizzleDb = drizzle(pool, {
                schema: { alert, locks, heartbeat },
                mode: 'default', // Standard MySQL mode (use 'planetscale' if using PlanetScale).
                logger: config.env === 'dev' ? true : false, // Enable query logging in dev mode for debugging.
            });

            logger.info('MySQL database initialized successfully');
            return;
        } catch (err) {
            logger.error(`Database connection attempt ${i + 1} failed:`, err);
            if (i === maxRetries - 1) throw new Error('Failed to connect to MySQL database after retries');
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff.
        }
    }
}

/**
 * Closes the MySQL connection pool gracefully.
 * - Called on process exit or error to release resources.
 * - Ensures no lingering connections on cPanel (important for shared hosting limits).
 */
export async function closeDb() {
    if (pool) {
        await pool.end();
        pool = null;
        drizzleDb = null;
        logger.info('MySQL database connection pool closed');
    }
}

/**
 * Database service with methods for alerts and locks.
 * - Uses Drizzle ORM for type-safe queries.
 * - Handles errors and logging for debugging (e.g., in cPanel logs or Telegram).
 * - Compatible with scanner-github.ts (single-scan cron jobs) and index-github.ts.
 */
export const dbService = {
    /**
     * Creates a new alert in the 'alert' table.
     * - Used when users add alerts via your bot's interface.
     * - Returns the inserted alert with auto-generated ID.
     */
    async createAlert(alertData: NewAlert): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const [inserted] = await drizzleDb.insert(alert).values(alertData).execute();
        return inserted.insertId;
    },

    /**
     * Fetches all active alerts ('status' = 'active').
     * - Used for global scans or admin views.
     * - Filters by status to ignore 'triggered' or 'canceled' alerts.
     */
    async getActiveAlerts(): Promise<Alert[]> {
        if (!drizzleDb) throw new Error('Database not initialized');
        return drizzleDb.select().from(alert).where(eq(alert.status, 'active')).execute();
    },

    /**
     * Fetches active alerts for a specific symbol (e.g., 'BTC/USDT').
     * - Used in scanner-github.ts (processDatabaseAlerts) to check conditions during scans.
     * - Filters by symbol and status for efficient querying.
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
     * Updates an alert's status (e.g., to 'triggered' after a signal).
     * - Used in scanner-github.ts (processDatabaseAlerts) to mark triggered alerts.
     * - Throws an error if the alert ID is not found.
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
     * Deletes an alert by ID (e.g., user cancels an alert).
     * - Used in admin or user interfaces.
     * - No return value, as it's a delete operation.
     */
    async deleteAlert(id: number): Promise<void> {
        if (!drizzleDb) throw new Error('Database not initialized');
        await drizzleDb.delete(alert).where(eq(alert.id, id)).execute();
    },

    /**
     * Gets the latest alert timestamp per symbol for cooldown checks.
     * - Used in scanner-github.ts (processTradeSignal) to enforce cooldownMs (e.g., 5 minutes).
     * - Aggregates the max lastAlertAt per symbol from active alerts.
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
     * Sets the last alert timestamp for a specific alert ID.
     * - Used in scanner-github.ts (processDatabaseAlerts) after sending a Telegram alert.
     * - Updates the 'lastAlertAt' field to enforce cooldowns.
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
     * Gets the lock status for concurrent run prevention (e.g., in cron jobs).
     * - Returns true if locked (bot is running), false otherwise.
     * - Used in index-github.ts to skip overlapping scans.
     */
    async getLock(): Promise<boolean> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const result = await drizzleDb.select().from(locks).where(eq(locks.id, 1)).execute();
        return result.length > 0 ? result[0].isLocked! : false;
    },

    /**
     * Sets the lock status to prevent concurrent executions.
     * - Used in index-github.ts (acquire/release) to ensure one scan per cron job.
     * - Uses ON DUPLICATE KEY UPDATE for idempotency.
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
     * Gets the current heartbeat cycle count from the database.
     * @returns {Promise<number>} The current cycle count
     */
    async getHeartbeatCount(): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        const result = await drizzleDb.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        return result.length > 0 ? result[0].cycleCount : 0;
    },

    /**
     * Increments the heartbeat cycle count in the database.
     * @returns {Promise<number>} The new cycle count
     */
    async incrementHeartbeatCount(): Promise<number> {
        if (!drizzleDb) throw new Error('Database not initialized');
        await drizzleDb
            .update(heartbeat)
            .set({ cycleCount: sql`cycleCount + 1`, lastHeartbeatAt: Date.now() })
            .where(eq(heartbeat.id, 1))
            .execute();
        const result = await drizzleDb.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        return result[0].cycleCount;
    },

    /**
     * Resets the heartbeat cycle count to 0.
     * @returns {Promise<void>}
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

// Initialize the database connection on module load (runs at startup).
initializeClient().catch(err => {
    logger.error('Failed to initialize MySQL database:', err);
    process.exit(1);
});
