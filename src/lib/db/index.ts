// src/lib/db/index.ts
// =============================================================================
// DATABASE SERVICE LAYER – DRIZZLE ORM + MYSQL2
// This is the SINGLE SOURCE OF TRUTH for all database interactions
// Used by: signal detector, trade simulator, ML trainer, bot controller
// =============================================================================

import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { and, eq, gte, isNull, not, sql, count, desc, sum } from 'drizzle-orm';

// Import all table definitions and types from schema
import {
    alert,
    locks,
    heartbeat,
    trainingSamples,
    trades,
    simulatedTrades,
    type Alert,
    type NewAlert,
    type TrainingSample,
    type NewTrainingSample,
    type NewTrade,
    type SimulatedTrade,
    type NewSimulatedTrade,
    coolDownTable,
} from './schema';

import { config } from '../config/settings';
import { createLogger } from '../logger';

// Dedicated logger for all database operations
const logger = createLogger('db');

// =============================================================================
// VALIDATE CRITICAL CONFIG AT STARTUP
// =============================================================================
if (!config.databaseUrl) {
    logger.error('FATAL: DATABASE_URL is missing from config');
    throw new Error('DATABASE_URL environment variable is required');
}

// =============================================================================
// DATABASE SERVICE CLASS
// Singleton pattern – only one instance ever exists (dbService)
// Handles connection pooling, retries, schema access, and all CRUD
// =============================================================================
class DatabaseService {
    private pool: mysql.Pool | null = null;           // MySQL connection pool
    private drizzleDb: MySql2Database<any> | null = null; // Drizzle ORM instance

    // =========================================================================
    // INITIALIZE DATABASE CONNECTION WITH EXPONENTIAL BACKOFF
    // Critical for Docker/K8s environments where DB starts after app
    // =========================================================================
    public async initialize(): Promise<void> {
        const maxRetries = 3;
        const baseDelayMs = 2000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.info(`Attempting MySQL connection (attempt ${attempt}/${maxRetries})`);

                // Create connection pool with sane defaults
                this.pool = mysql.createPool({
                    uri: config.databaseUrl,
                    connectionLimit: 5,        // Prevent overload
                    waitForConnections: true,  // Queue if no connections
                    queueLimit: 0,             // Unlimited queue
                    timezone: '+00:00',        // Always UTC
                    charset: 'utf8mb4',
                });

                // Test the connection immediately
                await this.pool.execute('SELECT 1');

                // Initialize Drizzle ORM with full schema
                this.drizzleDb = drizzle(this.pool, {
                    schema: {
                        alert,
                        locks,
                        heartbeat,
                        trainingSamples,
                        trades,
                        simulatedTrades,
                        coolDownTable
                    },
                    mode: 'default',
                    logger: config.env === 'dev', // Only log queries in development
                });

                logger.info('MySQL connection established and Drizzle ORM initialized');
                logger.info(`Connected to database: ${config.databaseUrl.split('@')[1]?.split('/')[1] || 'unknown'}`);
                return;
            } catch (err: any) {
                logger.error(`Database connection failed (attempt ${attempt})`, {
                    error: err.message,
                    code: err.code,
                    errno: err.errno,
                });

                if (attempt === maxRetries) {
                    logger.error('All connection attempts failed. Giving up.');
                    throw new Error(`Failed to connect to MySQL after ${maxRetries} attempts: ${err.message}`);
                }

                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                logger.warn(`Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // =========================================================================
    // GETTER FOR DRIZZLE INSTANCE – THROWS IF NOT INITIALIZED
    // =========================================================================
    public get db(): MySql2Database<any> {
        if (!this.drizzleDb) {
            throw new Error('Database not initialized. You must call dbService.initialize() first.');
        }
        return this.drizzleDb;
    }

    // =========================================================================
    // GRACEFUL SHUTDOWN – CLOSE POOL
    // =========================================================================
    public async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            logger.info('MySQL connection pool closed gracefully');
            this.pool = null;
            this.drizzleDb = null;
        }
    }

    // =========================================================================
    // ALERT MANAGEMENT
    // Used by alert scanner to fetch active user-defined signals
    // =========================================================================
    public async getActiveAlerts(): Promise<Alert[]> {
        const rows = await this.db
            .select()
            .from(alert)
            .where(eq(alert.status, 'active'))
            .execute();

        // JSON conditions are stored as string in DB → parse them back
        return rows.map(a => ({
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        }));
    }

    public async createAlert(alertData: NewAlert): Promise<number> {
        const [result] = await this.db.insert(alert).values(alertData).execute();
        logger.debug('Created new alert', { id: result.insertId, symbol: alertData.symbol });
        return result.insertId;
    }

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

    public async getAlertsById(id: number): Promise<Alert | undefined> {
        const result = await this.db.select().from(alert).where(eq(alert.id, id)).execute();
        if (result.length === 0) return undefined;
        const a = result[0];
        return {
            ...a,
            conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
        };
    }

    public async updateAlert(id: number, alertData: Partial<NewAlert>): Promise<boolean> {
        const result = await this.db
            .update(alert)
            .set({ ...alertData, conditions: alertData.conditions ? alertData.conditions : undefined })
            .where(eq(alert.id, id))
            .execute();
        return result[0].affectedRows > 0;
    }

    public async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<boolean> {
        const result = await this.db
            .update(alert)
            .set({ status })
            .where(eq(alert.id, id))
            .execute();
        return result[0].affectedRows > 0;
    }

    public async setLastAlertTime(id: number, timestamp: number): Promise<void> {
        await this.db
            .update(alert)
            .set({ lastAlertAt: timestamp })
            .where(eq(alert.id, id))
            .execute();
    }


    public async deleteAlert(id: number): Promise<boolean> {
        const result = await this.db.delete(alert).where(eq(alert.id, id)).execute();
        return result[0].affectedRows > 0;
    }

    public async logTrade(tradeData: NewTrade): Promise<number> {
        const [inserted] = await this.db.insert(trades).values(tradeData).execute();
        logger.debug(`Logged trade for ${tradeData.symbol}`, { id: inserted.insertId });
        return inserted.insertId;
    }

    // =========================================================================
    // BOT CONTROL: LOCKS & HEARTBEAT
    // Prevents multiple instances from running simultaneously
    // =========================================================================
    public async getLock(): Promise<boolean> {
        const [row] = await this.db
            .select({ isLocked: locks.isLocked })
            .from(locks)
            .where(eq(locks.id, 1))
            .execute();
        return row?.isLocked ?? false;
    }

    public async setLock(isLocked: boolean): Promise<void> {
        await this.db
            .insert(locks)
            .values({ id: 1, isLocked })
            .onDuplicateKeyUpdate({ set: { isLocked } })
            .execute();
    }

    // --- Heartbeat Management ---
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

    public async incrementHeartbeatCount(): Promise<number> {
        const [current] = await this.db
            .select({ cycleCount: heartbeat.cycleCount })
            .from(heartbeat)
            .where(eq(heartbeat.id, 1))
            .execute();

        const nextCount = (current?.cycleCount ?? 0) + 1;

        await this.db
            .insert(heartbeat)
            .values({
                id: 1,
                cycleCount: nextCount,
                lastHeartbeatAt: Date.now(),
            })
            .onDuplicateKeyUpdate({
                set: { cycleCount: nextCount, lastHeartbeatAt: Date.now() },
            })
            .execute();

        return nextCount;
    }

    public async resetHeartbeatCount(): Promise<void> {
        await this.db
            .insert(heartbeat)
            .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
            .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
            .execute();
    }

    public async getCoolDown(symbol: string): Promise<{
        id: number;
        symbol: string | null;
        lastTradeAt: number;
    }> {
        const rows = await this.db.select().from(coolDownTable).where(eq(coolDownTable.symbol, symbol)).execute();
        return rows[0];
    }

    public async upsertCoolDown(symbol: string, lastTradeAt: number): Promise<void> {
        await this.db.insert(coolDownTable)
        .values({ symbol, lastTradeAt })
        .onDuplicateKeyUpdate({ set: { lastTradeAt } })
        .execute();
    }

    // =========================================================================
    // ML TRAINING SAMPLES – STORES FEATURES + FINAL LABEL
    // This is what your Random Forest / XGBoost model will train on
    // =========================================================================
    public async addTrainingSample(sample: NewTrainingSample): Promise<number> {
        const [result] = await this.db
            .insert(trainingSamples)
            .values({
                symbol: sample.symbol,
                features: sample.features,
                label: sample.label,
            })
            .execute();

        logger.debug('Added ML training sample', {
            id: result.insertId,
            symbol: sample.symbol,
            label: sample.label,
            featureCount: sample.features.length,
        });

        return result.insertId;
    }

    public async getTrainingSamples(): Promise<TrainingSample[]> {
        const rows = await this.db
            .select()
            .from(trainingSamples)
            .orderBy(desc(trainingSamples.id))
            .execute();

        return rows.map(s => ({
            ...s,
            features: typeof s.features === 'string' ? JSON.parse(s.features) : s.features,
        }));
    }

    public async getSampleCount(symbol?: string): Promise<number> {
        if (symbol) {
            const [row] = await this.db
                .select({ count: count() })
                .from(trainingSamples)
                .where(eq(trainingSamples.symbol, symbol))
                .execute();
            return row.count;
        }
        const [row] = await this.db.select({ count: count() }).from(trainingSamples).execute();
        return row.count;
    }

    public async getSampleSummary(): Promise<
        { symbol: string; total: number; buys: number; sells: number; wins: number }[]
    > {
        const result = await this.db
            .select({
                symbol: trainingSamples.symbol,
                total: count(),
                wins: sum(sql`CASE WHEN ${trainingSamples.label} = 1 THEN 1 ELSE 0 END`),
                buys: sum(sql`CASE WHEN ${trainingSamples.label} = 1 THEN 1 ELSE 0 END`), // buy = win
                sells: sum(sql`CASE WHEN ${trainingSamples.label} = -1 THEN 1 ELSE 0 END`), // sell = loss
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

    // --- Simulated Trades (Paper Trading) ---
    public async startSimulatedTrade(trade: Omit<NewSimulatedTrade, 'signalId' | 'openedAt'>): Promise<string> {
        const signalId = crypto.randomUUID();

        // Cast to any to satisfy Drizzle's insert typings and avoid bigint literal issues.
        await this.db.insert(simulatedTrades).values({
            ...trade,
            signalId,
            openedAt: Date.now(),
            // Initialize all result fields as null/0 (use number 0 instead of bigint 0n)
            outcome: null!,
            pnl: 0,
            rMultiple: null,
            label: null,
            maxFavorableExcursion: null,
            maxAdverseExcursion: null,
        } as any).execute();

        logger.info('Started new simulated trade', {
            signalId,
            symbol: trade.symbol,
            side: trade.side,
            entryPrice: (Number(trade.entryPrice)).toFixed(8),
            hasTpLevels: !!trade.tpLevels,
            hasTrailing: !!trade.trailingDist,
        });

        return signalId;
    }

    /**
     * CLOSE SIMULATED TRADE WITH FULL ML-READY RESULTS
     * This is the most important function in the entire system
     */
    public async closeSimulatedTrade(
        signalId: string,
        outcome: 'tp' | 'partial_tp' | 'sl' | 'timeout',
        pnl: number,                    // e.g. 0.0567 → +5.67%
        rMultiple: number,              // e.g. 2.34 → 2.34R
        label: -2 | -1 | 0 | 1 | 2,     // Final ML label
        maxFavorablePrice: number,      // Best price reached in favorable direction
        maxAdversePrice: number         // Worst price reached against position
    ): Promise<void> {
        // Fetch the original trade to get entry price and side
        const [trade] = await this.db
            .select({
                entryPrice: simulatedTrades.entryPrice,
                side: simulatedTrades.side,
                symbol: simulatedTrades.symbol,
            })
            .from(simulatedTrades)
            .where(eq(simulatedTrades.signalId, signalId))
            .execute();

        if (!trade) {
            logger.error('Cannot close simulated trade – signalId not found', { signalId });
            return;
        }

        const isLong = trade.side === 'buy';
        const entryPrice = Number(trade.entryPrice) / 1e8;

        // Calculate MFE/MAE in price units × 1e8 (for storage)
        const mfe = isLong
            ? Math.round((maxFavorablePrice - entryPrice) * 1e8)
            : Math.round((entryPrice - maxFavorablePrice) * 1e8);

        const mae = isLong
            ? Math.round((entryPrice - maxAdversePrice) * 1e8)
            : Math.round((maxAdversePrice - entryPrice) * 1e8);

        // Final update with all results
        await this.db
            .update(simulatedTrades)
            .set({
                closedAt: Date.now(),
                outcome,
                pnl: Number(Math.round(pnl * 1e8)),
                rMultiple: rMultiple === null ? null : Number(Math.round(rMultiple * 1e4)),
                label,
                maxFavorableExcursion: Number(mfe),
                maxAdverseExcursion: Number(mae),
            })
            .where(eq(simulatedTrades.signalId, signalId))
            .execute();

        logger.info('SIMULATED TRADE CLOSED – ML LABEL READY', {
            signalId,
            symbol: trade.symbol,
            side: trade.side,
            outcome: outcome.toUpperCase(),
            pnlPercent: `${(pnl * 100).toFixed(2)}%`,
            rMultiple: rMultiple.toFixed(3),
            label,
            mfe: `${(mfe / 1e8).toFixed(6)}`,
            mae: `${(mae / 1e8).toFixed(6)}`,
        });
    }

    // Get currently running simulations
    public async getOpenSimulatedTrades(): Promise<SimulatedTrade[]> {
        return await this.db
            .select()
            .from(simulatedTrades)
            .where(isNull(simulatedTrades.closedAt))
            .execute();
    }

    // Get recent closed simulations (for debugging)
    public async getClosedSimulatedTrades(limit = 500): Promise<SimulatedTrade[]> {
        return await this.db
            .select()
            .from(simulatedTrades)
            .where(not(isNull(simulatedTrades.closedAt)))
            .orderBy(desc(simulatedTrades.closedAt))
            .limit(limit)
            .execute();
    }

    // =========================================================================
    // ANALYTICS & INSIGHTS
    // These queries power your ML performance dashboard
    // =========================================================================
    public async getSimulationStats() {
        return await this.db
            .select({
                label: simulatedTrades.label,
                count: count(),
                avgPnl: sql<number>`ROUND(AVG(${simulatedTrades.pnl} / 1e8), 6)`.mapWith(Number),
                avgR: sql<number>`ROUND(AVG(${simulatedTrades.rMultiple} / 1e4), 3)`.mapWith(Number),
                winRate: sql<number>`
          ROUND(
            SUM(CASE WHEN ${simulatedTrades.label} >= 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0),
            2
          )
        `.mapWith(Number),
            })
            .from(simulatedTrades)
            .where(not(isNull(simulatedTrades.closedAt)))
            .groupBy(simulatedTrades.label)
            .orderBy(simulatedTrades.label)
            .execute();
    }

    public async getTopPerformingSymbols(limit = 20) {
        return await this.db
            .select({
                symbol: simulatedTrades.symbol,
                trades: count(),
                avgR: sql<number>`ROUND(AVG(${simulatedTrades.rMultiple} / 1e4), 3)`.mapWith(Number),
                strongWins: sql<number>`SUM(CASE WHEN ${simulatedTrades.label} = 2 THEN 1 ELSE 0 END)`.mapWith(Number)
            })
            .from(simulatedTrades)
            .where(and(
                not(isNull(simulatedTrades.closedAt)),
                gte(simulatedTrades.label, 1)
            ))
            .groupBy(simulatedTrades.symbol)
            .orderBy(sql`avgR DESC`)
            .limit(limit)
            .execute();
    }

    // ===========================================================================
    // ML: LABEL DISTRIBUTION – CRITICAL FOR MONITORING CLASS BALANCE
    // ===========================================================================
    public async getLabelDistribution(): Promise<{ label: number; count: number }[]> {
        const result = await this.db
            .select({
                label: trainingSamples.label,
                count: count().as('count'),
            })
            .from(trainingSamples)
            .groupBy(trainingSamples.label)
            .orderBy(trainingSamples.label)
            .execute();

        // Ensure all 5 labels (-2 to +2) appear, even if count = 0
        const distributionMap = new Map<number, number>();
        for (let label = -2; label <= 2; label++) {
            distributionMap.set(label, 0);
        }

        for (const row of result) {
            if (row.label !== null) {
                distributionMap.set(row.label, row.count);
            }
        }

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
export const initializeClient = dbService.initialize.bind(dbService);
export const closeDb = dbService.close.bind(dbService);
