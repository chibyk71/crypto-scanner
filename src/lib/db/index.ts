/**
 * Provides Drizzle ORM functionality for interacting with a MySQL database.
 * - Uses type-safe queries for the `alert`, `locks`, `heartbeat`, `training_samples`, and `trades` tables.
 * - Manages database connections and schema operations.
 * @see https://orm.drizzle.team/docs/overview
 */
import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';

/**
 * Provides a promise-based MySQL client for creating connection pools.
 * - Used to establish and manage database connections.
 * @see https://www.npmjs.com/package/mysql2
 */
import mysql from 'mysql2/promise';

/**
 * Drizzle ORM utilities for constructing SQL queries.
 * - Includes logical operators and equality checks for query building.
 */
import { and, count, eq, sql, sum } from 'drizzle-orm';

/**
 * Database schema definitions and types for all tables.
 * - Includes `alert`, `locks`, `heartbeat`, `training_samples`, and `trades` tables.
 * - Defines structure and TypeScript types for type-safe queries.
 */
import {
    alert,
    locks,
    heartbeat,
    trainingSamples,
    trades,
    type Alert,
    type NewAlert,
    type TrainingSample,
    type NewTrainingSample,
    type Trade,
    type NewTrade,
} from './schema';

/**
 * Application configuration, including the database URL.
 * - Used to establish the MySQL connection.
 */
import { config } from '../config/settings';

/**
 * Logger utility for database-related events and errors.
 * - Tagged with 'db' context for categorized logging.
 */
import { createLogger } from '../logger';

/**
 * Logger instance for database operations.
 * - Facilitates debugging and monitoring of database interactions.
 */
const logger = createLogger('db');

/**
 * Validates the database URL at module level to ensure early failure.
 * - Required format: mysql://user:pass@localhost:3306/dbname
 * - Throws an error if not set, preventing startup with invalid config.
 */
if (!config.database_url) {
    logger.error('DATABASE_URL is not set in configuration');
    throw new Error('DATABASE_URL is not set in configuration');
}

/**
 * Centralized database service class for MySQL and Drizzle ORM interactions.
 * - Manages connection pooling, schema initialization, and query execution.
 * - Provides methods for alerts, locks, heartbeats, training samples, and trades.
 * - Ensures a single point of control for all database operations.
 */
class DatabaseService {
    /**
     * MySQL connection pool, initialized during `initialize`.
     * @private
     */
    private pool: mysql.Pool | null = null;

    /**
     * Drizzle ORM instance, configured with the database schema.
     * - Provides type-safe query methods for all defined tables.
     * @private
     */
    private drizzleDb: MySql2Database<{
        alert: typeof alert;
        locks: typeof locks;
        heartbeat: typeof heartbeat;
        trainingSamples: typeof trainingSamples;
        trades: typeof trades;
    }> | null = null;

    /**
     * Initializes the MySQL connection pool and Drizzle ORM instance.
     * - Uses exponential back-off for retrying transient connection failures.
     * - Creates necessary tables if they don't exist.
     * - Tests the connection with a simple query to ensure reliability.
     * @throws {Error} If connection fails after maximum retries.
     */
    public async initialize(): Promise<void> {
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                logger.info(`Attempting to connect to MySQL (attempt ${i + 1})`);
                this.pool = mysql.createPool({ uri: config.database_url, connectionLimit: 3 });

                // Test connection with a simple query
                await this.pool.execute('SELECT 1');

                this.drizzleDb = drizzle(this.pool, {
                    schema: { alert, locks, heartbeat, trainingSamples, trades },
                    mode: 'default',
                    logger: config.env === 'dev', // Enable query logging in development
                });

                logger.info('MySQL database and tables initialized successfully');
                return;
            } catch (err: any) {
                logger.error(`Database connection attempt ${i + 1} failed: ${err.message}`);
                if (i === maxRetries - 1) {
                    throw new Error(`Failed to connect to MySQL database after ${maxRetries} retries: ${err.message}`);
                }
                const delay = 1000 * Math.pow(2, i);
                logger.warn(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Retrieves the Drizzle ORM instance, ensuring initialization.
     * @returns {MySql2Database} The Drizzle ORM instance.
     * @throws {Error} If the database is not initialized.
     * @private
     */
    public get db(): MySql2Database<any> {
        if (!this.drizzleDb) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        return this.drizzleDb;
    }

    /**
     * Closes the MySQL connection pool and resets internal state.
     * - Ensures resources are released during application shutdown.
     */
    public async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            logger.info('MySQL database connection pool closed');
            this.pool = null;
            this.drizzleDb = null;
        }
    }

    // --- Alert Management ---

    /**
     * Retrieves all active alerts from the `alert` table.
     * @returns {Promise<Alert[]>} Array of active alerts with parsed JSON conditions.
     */
    public async getActiveAlerts(): Promise<Alert[]> {
        const alerts = await this.db.select().from(alert).where(eq(alert.status, 'active')).execute();
        return alerts.map(a => ({
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        }));
    }

    /**
     * Creates a new alert record in the `alert` table.
     * @param alertData - The data for the new alert, conforming to the `NewAlert` type.
     * @returns {Promise<number>} The ID of the inserted alert.
     */
    public async createAlert(alertData: NewAlert): Promise<number> {
        const [inserted] = await this.db
            .insert(alert)
            .values({
                ...alertData,
                conditions: alertData.conditions, // Serialize JSON
            })
            .execute();
        logger.debug(`Created alert for ${alertData.symbol}`, { id: inserted.insertId });
        return inserted.insertId;
    }

    /**
     * Retrieves alerts for a specific trading symbol.
     * @param symbol - The trading symbol (e.g., 'BTC/USDT').
     * @returns {Promise<Alert[]>} Array of active alerts for the symbol.
     */
    public async getAlertsBySymbol(symbol: string): Promise<Alert[]> {
        const alerts = await this.db
            .select()
            .from(alert)
            .where(and(eq(alert.symbol, symbol), eq(alert.status, 'active')))
            .execute();
        return alerts.map(a => ({
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        }));
    }

    /**
     * Retrieves an alert by its ID.
     * @param id - The ID of the alert to retrieve.
     * @returns {Promise<Alert | undefined>} The alert record, or `undefined` if not found.
     */
    public async getAlertsById(id: number): Promise<Alert | undefined> {
        const result = await this.db.select().from(alert).where(eq(alert.id, id)).execute();
        if (result.length === 0) return undefined;
        const alertData = result[0];
        return {
            ...alertData,
            conditions: typeof alertData.conditions === 'string' ? JSON.parse(alertData.conditions) : alertData.conditions,
        };
    }

    /**
     * Updates an existing alert in the `alert` table.
     * @param id - The ID of the alert to update.
     * @param alertData - The updated data for the alert, conforming to the `Partial<NewAlert>` type.
     * @returns {Promise<boolean>} `true` if the update was successful, `false` otherwise.
     */
    public async updateAlert(id: number, alertData: Partial<NewAlert>): Promise<boolean> {
        const result = await this.db
            .update(alert)
            .set({
                ...alertData,
                conditions: alertData.conditions ? alertData.conditions : undefined,
            })
            .where(eq(alert.id, id))
            .execute();
        logger.debug(`Updated alert ${id}`, { affectedRows: result[0].affectedRows });
        return result[0].affectedRows > 0;
    }

    /**
     * Updates the status of an alert to either 'triggered' or 'canceled'.
     * @param id - The ID of the alert to update.
     * @param status - The new status ('triggered' or 'canceled').
     * @returns {Promise<boolean>} `true` if the update was successful, `false` otherwise.
     */
    public async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<boolean> {
        const result = await this.db.update(alert).set({ status }).where(eq(alert.id, id)).execute();
        logger.debug(`Updated alert ${id} status to ${status}`, { affectedRows: result[0].affectedRows });
        return result[0].affectedRows > 0;
    }

    /**
     * Updates the last alert timestamp for an alert.
     * @param id - The alert ID.
     * @param timestamp - Unix timestamp (ms) of the last alert.
     * @returns {Promise<boolean>} True if updated successfully.
     */
    public async setLastAlertTime(id: number, timestamp: number): Promise<boolean> {
        const result = await this.db
            .update(alert)
            .set({ lastAlertAt: timestamp })
            .where(eq(alert.id, id))
            .execute();
        logger.debug(`Set last alert time for alert ${id}`, { timestamp, affectedRows: result[0].affectedRows });
        return result[0].affectedRows > 0;
    }

    /**
     * Deletes an alert by its ID.
     * @param id - The ID of the alert to delete.
     * @returns {Promise<boolean>} `true` if the deletion was successful, `false` otherwise.
     */
    public async deleteAlert(id: number): Promise<boolean> {
        const result = await this.db.delete(alert).where(eq(alert.id, id)).execute();
        logger.debug(`Deleted alert ${id}`, { affectedRows: result[0].affectedRows });
        return result[0].affectedRows > 0;
    }

    /**
     * Logs a trade to the `trades` table.
     * @param tradeData - The data for the new trade, conforming to the `NewTrade` type.
     * @returns {Promise<number>} The ID of the inserted trade.
     */
    public async logTrade(tradeData: NewTrade): Promise<number> {
        const [inserted] = await this.db
            .insert(trades)
            .values({
                ...tradeData,
                timestamp: tradeData.timestamp,
            })
            .execute();
        logger.debug(`Logged trade for ${tradeData.symbol}`, {
            id: inserted.insertId,
            side: tradeData.side,
            mode: tradeData.mode,
        });
        return inserted.insertId;
    }

    // --- Lock Management ---

    /**
     * Checks if the global lock is active (id=1).
     * @returns {Promise<boolean>} True if locked, false otherwise.
     */
    public async getLock(): Promise<boolean> {
        const result = await this.db.select().from(locks).where(eq(locks.id, 1)).execute();
        return result.length > 0 ? result[0].isLocked! : false;
    }

    /**
     * Sets the global lock state (id=1).
     * @param isLocked - True to lock, false to unlock.
     */
    public async setLock(isLocked: boolean): Promise<void> {
        await this.db
            .insert(locks)
            .values({ id: 1, isLocked })
            .onDuplicateKeyUpdate({ set: { isLocked } })
            .execute();
        logger.debug(`Set lock state to ${isLocked}`);
    }

    // --- Heartbeat Management ---

    /**
     * Retrieves the current heartbeat cycle count and timestamp.
     * @returns {Promise<Heartbeat>} The heartbeat record.
     */
    public async getHeartbeatCount(): Promise<number> {
        const result = await this.db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        if (result.length === 0) {
            await this.db
                .insert(heartbeat)
                .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
                .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
                .execute();
            return 0;
        }
        return result[0].cycleCount;
    }

    /**
     * Increments the heartbeat cycle count and updates the timestamp.
     * @returns {Promise<number>} The updated cycle count.
     */
    public async incrementHeartbeatCount(): Promise<number> {
        const result = await this.db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        const cycleCount = result.length === 0 ? 1 : result[0].cycleCount + 1;
        await this.db
            .insert(heartbeat)
            .values({ id: 1, cycleCount, lastHeartbeatAt: Date.now() })
            .onDuplicateKeyUpdate({ set: { cycleCount, lastHeartbeatAt: Date.now() } })
            .execute();
        logger.debug(`Incremented heartbeat count to ${cycleCount}`);
        return cycleCount;
    }

    /**
     * Resets the heartbeat cycle count and timestamp.
     */
    public async resetHeartbeatCount(): Promise<void> {
        await this.db
            .insert(heartbeat)
            .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
            .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
            .execute();
        logger.debug('Reset heartbeat count');
    }

    // --- Training Samples Management ---

    /**
     * Adds a training sample to the `training_samples` table.
     * @param sample - The training sample data (symbol, features, label).
     * @returns {Promise<number>} The ID of the inserted sample.
     */
    public async addTrainingSample(sample: NewTrainingSample): Promise<number> {
        const [inserted] = await this.db
            .insert(trainingSamples)
            .values({
                symbol: sample.symbol,
                features: sample.features,
                label: sample.label,
            })
            .execute();
        logger.debug(`Added training sample for ${sample.symbol}`, { id: inserted.insertId, label: sample.label });
        return inserted.insertId;
    }

    /**
     * Retrieves all training samples from the `training_samples` table.
     * @returns {Promise<TrainingSample[]>} Array of training samples.
     */
    public async getTrainingSamples(): Promise<TrainingSample[]> {
        const samples = await this.db.select().from(trainingSamples).execute();
        return samples.map(s => ({
            ...s,
            features: typeof s.features === 'string' ? JSON.parse(s.features) : s.features,
        }));
    }

    /**
     * Retrieves the count of training samples, optionally filtered by symbol.
     * @param symbol - Optional symbol to filter samples.
     * @returns {Promise<number>} The number of samples.
     */
    public async getSampleCount(symbol?: string): Promise<number> {
        if (symbol) {
            const result = await this.db
                .select({ count: count() })
                .from(trainingSamples)
                .where(eq(trainingSamples.symbol, symbol))
                .execute();
            return result[0].count;
        }
        const result = await this.db.select({ count: count() }).from(trainingSamples).execute();
        return result[0].count;
    }

    /**
     * Retrieves a summary of training samples by symbol.
     * @returns {Promise<{ symbol: string; total: number; buys: number; sells: number; wins: number }[]>} Summary statistics.
     */
    public async getSampleSummary(): Promise<{ symbol: string; total: number; buys: number; sells: number; wins: number }[]> {
        const result = await this.db
            .select({
                symbol: trainingSamples.symbol,
                total: count(),
                buys: sum(sql`CASE WHEN ${trainingSamples.label} = 1 THEN 1 ELSE 0 END`),
                sells: sum(sql`CASE WHEN ${trainingSamples.label} = -1 THEN 1 ELSE 0 END`),
                wins: sum(sql`CASE WHEN ${trainingSamples.label} = 1 AND ${trainingSamples.label} = 1 THEN 1 WHEN ${trainingSamples.label} = -1 AND ${trainingSamples.label} = -1 THEN 1 ELSE 0 END`),
            })
            .from(trainingSamples)
            .groupBy(trainingSamples.symbol)
            .execute();
        return result.map(r => ({
            symbol: r.symbol,
            total: r.total,
            buys: Number(r.buys),
            sells: Number(r.sells),
            wins: Number(r.wins),
        }));
    }
}

/**
 * Singleton instance of the DatabaseService class.
 * - Provides a single point of access for all database operations.
 * @example
 * ```typescript
 * import { dbService, initializeClient } from './db';
 * await initializeClient();
 * const alerts = await dbService.getActiveAlerts();
 * ```
 */
export const dbService = new DatabaseService();

/**
 * Initializes the database connection.
 * - Bound to the singleton instance for convenience.
 * @example
 * ```typescript
 * import { initializeClient } from './db';
 * await initializeClient();
 * ```
 */
export const initializeClient = dbService.initialize.bind(dbService);

/**
 * Closes the database connection.
 * - Bound to the singleton instance for convenience.
 * @example
 * ```typescript
 * import { closeDb } from './db';
 * await closeDb();
 * ```
 */
export const closeDb = dbService.close.bind(dbService);
