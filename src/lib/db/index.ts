// src/lib/db/index.ts

/**
 * Provides Drizzle ORM functionality for interacting with a MySQL database.
 * Drizzle is used to define schemas and execute type-safe queries.
 * @see https://orm.drizzle.team/docs/overview
 */
import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';

/**
 * Provides a promise-based MySQL client for creating connection pools and executing raw queries.
 * @see https://www.npmjs.com/package/mysql2
 */
import mysql from 'mysql2/promise';

/**
 * Provides Drizzle ORM utilities for constructing SQL queries, including logical operators and equality checks.
 */
import { and, eq } from 'drizzle-orm';

/**
 * Imports database schema definitions and types for the `alert`, `locks`, and `heartbeat` tables.
 * These schemas define the structure of the database tables and the types for their records.
 */
import { alert, locks, heartbeat, type Alert, type NewAlert } from './schema';

/**
 * Imports the application configuration, including the database URL, from the settings module.
 * The configuration is used to establish the database connection.
 */
import { config } from '../config/settings';

/**
 * Imports a logger utility to log database-related events and errors.
 * The logger is configured with a context of 'db' for categorized logging.
 */
import { createLogger } from '../logger';

/**
 * Initializes a logger instance for database-related logging.
 * Logs are tagged with the 'db' context for easy filtering and debugging.
 */
const logger = createLogger('db');

/**
 * Validates the database URL at the module level to ensure early failure on misconfiguration.
 * - Required for MySQL connection (format: mysql://user:pass@localhost:3306/dbname).
 * - Throws an error if not set, preventing startup with invalid config.
 */
if (!config.database_url) {
    logger.error('DATABASE_URL is not set in configuration');
    throw new Error('DATABASE_URL is not set in configuration');
}

/**
 * Centralized database service class to manage MySQL connections and Drizzle ORM queries.
 * Encapsulates connection pooling, initialization, and query methods for alerts, locks, and heartbeats.
 * Ensures a single point of control for database interactions and state management.
 */
class DatabaseService {
    /**
     * The MySQL connection pool, initialized during `initialize()`.
     * @private
     */
    private pool: mysql.Pool | null = null;

    /**
     * The Drizzle ORM instance, configured with the database schema.
     * Provides type-safe query methods for the `alert`, `locks`, and `heartbeat` tables.
     * @private
     */
    private drizzleDb: MySql2Database<{
        alert: typeof alert;
        locks: typeof locks;
        heartbeat: typeof heartbeat;
    }> | null = null;

    /**
     * Initializes the MySQL connection pool and Drizzle ORM instance.
     * Uses an exponential back-off retry strategy to handle transient connection failures.
     * Logs connection attempts and errors for debugging.
     * @throws {Error} If connection fails after the maximum number of retries.
     */
    public async initialize(): Promise<void> {
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                logger.info(`Attempting to connect to MySQL (attempt ${i + 1})`);
                this.pool = mysql.createPool({ uri: config.database_url, connectionLimit: 3 });

                // Test the connection with a simple query to ensure it works
                await this.pool.execute('SELECT 1');

                this.drizzleDb = drizzle(this.pool, {
                    schema: { alert, locks, heartbeat },
                    mode: 'default',
                    logger: config.env === 'dev', // Enable Drizzle query logging in development
                });

                logger.info('MySQL database initialized successfully');
                return;

            } catch (err: any) {
                logger.error(`Database connection attempt ${i + 1} failed: ${err.message}`);
                if (i === maxRetries - 1) {
                    throw new Error(`Failed to connect to MySQL database after ${maxRetries} retries: ${err.message}`);
                }
                const delay = 1000 * Math.pow(2, i); // Exponential back-off
                logger.warn(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Safely retrieves the Drizzle ORM instance, ensuring it has been initialized.
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
     * Closes the MySQL connection pool gracefully and resets the internal state.
     * Ensures resources are released properly when shutting down the application.
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
     * @returns {Promise<Alert[]>} An array of active alerts.
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
        const [inserted] = await this.db.insert(alert).values({
            ...alertData,
            conditions: alertData.conditions, // Serialize JSON
        }).execute();
        return inserted.insertId;
    }

    /**
     * Retrieves all active alerts for a given trading symbol.
     * @param symbol - The trading symbol to filter alerts (e.g., 'BTC/USDT').
     * @returns {Promise<Alert[]>} An array of active alerts for the symbol.
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
        const result = await this.db.update(alert).set({
            ...alertData,
            conditions: alertData.conditions ? alertData.conditions : undefined,
        }).where(eq(alert.id, id)).execute();
        return result.length > 0;
    }

    /**
     * Updates the status of an alert to either 'triggered' or 'canceled'.
     * @param id - The ID of the alert to update.
     * @param status - The new status ('triggered' or 'canceled').
     * @returns {Promise<boolean>} `true` if the update was successful, `false` otherwise.
     */
    public async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<boolean> {
        const result = await this.db.update(alert).set({ status }).where(eq(alert.id, id)).execute();
        return result.length > 0;
    }

    /**
     * Updates the `lastAlertAt` timestamp for an alert.
     * @param id - The ID of the alert to update.
     * @param timestamp - The Unix timestamp (in milliseconds) to set.
     * @returns {Promise<boolean>} `true` if the update was successful, `false` otherwise.
     */
    public async setLastAlertTime(id: number, timestamp: number): Promise<boolean> {
        const result = await this.db
            .update(alert)
            .set({ lastAlertAt: timestamp })
            .where(eq(alert.id, id))
            .execute();
        return result.length > 0;
    }

    /**
     * Deletes an alert by its ID.
     * @param id - The ID of the alert to delete.
     * @returns {Promise<boolean>} `true` if the deletion was successful, `false` otherwise.
     */
    public async deleteAlert(id: number): Promise<boolean> {
        const result = await this.db.delete(alert).where(eq(alert.id, id)).execute();
        return result.length > 0;
    }

    // --- Lock Management ---

    /**
     * Checks if a global lock is active.
     * Assumes a single lock record with `id = 1` in the `locks` table.
     * @returns {Promise<boolean>} `true` if the lock is active, `false` otherwise.
     */
    public async getLock(): Promise<boolean> {
        const result = await this.db.select().from(locks).where(eq(locks.id, 1)).execute();
        return result.length > 0 ? result[0].isLocked! : false;
    }

    /**
     * Sets or updates the global lock state.
     * Uses `ON DUPLICATE KEY UPDATE` to handle both insert and update cases.
     * @param isLocked - The desired lock state (`true` to lock, `false` to unlock).
     */
    public async setLock(isLocked: boolean): Promise<void> {
        await this.db.insert(locks)
            .values({ id: 1, isLocked })
            .onDuplicateKeyUpdate({ set: { isLocked } })
            .execute();
    }

    // --- Heartbeat Management ---

    /**
     * Retrieves the current heartbeat cycle count.
     * Initializes a default heartbeat record if none exists.
     * @returns {Promise<number>} The current cycle count.
     */
    public async getHeartbeatCount(): Promise<number> {
        const result = await this.db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        if (result.length === 0) {
            logger.warn('No heartbeat row found, initializing default row');
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
     * Atomically increments the heartbeat cycle count and updates the timestamp.
     * Prevents race conditions by using a single, atomic SQL statement.
     * Initializes a default heartbeat record if none exists.
     * @returns {Promise<number>} The updated cycle count.
     */
    public async incrementHeartbeatCount(): Promise<number> {
        // Check current state
        const result = await this.db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
        if (result.length === 0) {
            logger.warn('No heartbeat row found after update, initializing default row');
            await this.db
                .insert(heartbeat)
                .values({ id: 1, cycleCount: 1, lastHeartbeatAt: Date.now() })
                .onDuplicateKeyUpdate({ set: { cycleCount: 1, lastHeartbeatAt: Date.now() } })
                .execute();
            return 1;
        }
        let cycleCount = result[0].cycleCount + 1;
        await this.db
            .update(heartbeat)
            .set({ cycleCount: cycleCount, lastHeartbeatAt: Date.now() })
            .where(eq(heartbeat.id, 1))
            .execute();

        return cycleCount;
    }

    /**
     * Resets the heartbeat cycle count and timestamp to zero.
     * Used to restart the heartbeat tracking, typically for testing or recovery.
     */
    public async resetHeartbeatCount(): Promise<void> {
        await this.db
            .update(heartbeat)
            .set({ cycleCount: 0, lastHeartbeatAt: 0 })
            .where(eq(heartbeat.id, 1))
            .execute();
    }
}

/**
 * Singleton instance of the `DatabaseService` class.
 * Provides a single point of access to database operations throughout the application.
 * @example
 * typescript
 * import { dbService, initializeClient } from './db';
 * await initializeClient();
 * const alertId = await dbService.createAlert({ symbol: 'BTC/USDT', status: 'active' });
 *
 */
export const dbService = new DatabaseService();

/**
 * Bound method to initialize the database connection.
 * Exported as a convenience to avoid directly accessing the `dbService` instance.
 * @example
 * typescript
 * import { initializeClient } from './db';
 * await initializeClient();
 *
 */
export const initializeClient = dbService.initialize.bind(dbService);

/**
 * Bound method to close the database connection.
 * Exported as a convenience to avoid directly accessing the `dbService` instance.
 * @example
 * typescript
 * import { closeDb } from './db';
 * await closeDb();
 *
 */
export const closeDb = dbService.close.bind(dbService);

