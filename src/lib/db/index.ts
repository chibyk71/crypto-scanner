// src/lib/db/index.ts
import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { and, count, eq, sql, sum, isNull } from 'drizzle-orm';
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
} from './schema';
import { config } from '../config/settings';
import { createLogger } from '../logger';

const logger = createLogger('db');

if (!config.database_url) {
  logger.error('DATABASE_URL is not set in configuration');
  throw new Error('DATABASE_URL is not set in configuration');
}

class DatabaseService {
  private pool: mysql.Pool | null = null;
  private drizzleDb: MySql2Database<any> | null = null;

  public async initialize(): Promise<void> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        logger.info(`Attempting to connect to MySQL (attempt ${i + 1})`);
        this.pool = mysql.createPool({ uri: config.database_url, connectionLimit: 3 });
        await this.pool.execute('SELECT 1');

        this.drizzleDb = drizzle(this.pool, {
          schema: { alert, locks, heartbeat, trainingSamples, trades, simulatedTrades },
          mode: 'default',
          logger: config.env === 'dev',
        });

        logger.info('MySQL database and tables initialized successfully');
        return;
      } catch (err: any) {
        logger.error(`Database connection attempt ${i + 1} failed: ${err.message}`);
        if (i === maxRetries - 1) {
          throw new Error(`Failed to connect to MySQL after ${maxRetries} retries: ${err.message}`);
        }
        const delay = 1000 * Math.pow(2, i);
        logger.warn(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  public get db(): MySql2Database<any> {
    if (!this.drizzleDb) throw new Error('Database not initialized. Call initialize() first.');
    return this.drizzleDb;
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      logger.info('MySQL database connection pool closed');
      this.pool = null;
      this.drizzleDb = null;
    }
  }

  // --- Alert Management ---
  public async getActiveAlerts(): Promise<Alert[]> {
    const alerts = await this.db.select().from(alert).where(eq(alert.status, 'active')).execute();
    return alerts.map(a => ({
      ...a,
      conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
    }));
  }

  public async createAlert(alertData: NewAlert): Promise<number> {
    const [inserted] = await this.db.insert(alert).values(alertData).execute();
    logger.debug(`Created alert for ${alertData.symbol}`, { id: inserted.insertId });
    return inserted.insertId;
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
    const result = await this.db.update(alert).set({ status }).where(eq(alert.id, id)).execute();
    return result[0].affectedRows > 0;
  }

  public async setLastAlertTime(id: number, timestamp: number): Promise<boolean> {
    const result = await this.db.update(alert).set({ lastAlertAt: timestamp }).where(eq(alert.id, id)).execute();
    return result[0].affectedRows > 0;
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

  // --- Lock Management ---
  public async getLock(): Promise<boolean> {
    const result = await this.db.select().from(locks).where(eq(locks.id, 1)).execute();
    return result.length > 0 ? result[0].isLocked! : false;
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
    const result = await this.db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();
    const cycleCount = result.length === 0 ? 1 : result[0].cycleCount + 1;
    await this.db
      .insert(heartbeat)
      .values({ id: 1, cycleCount, lastHeartbeatAt: Date.now() })
      .onDuplicateKeyUpdate({ set: { cycleCount, lastHeartbeatAt: Date.now() } })
      .execute();
    return cycleCount;
  }

  public async resetHeartbeatCount(): Promise<void> {
    await this.db
      .insert(heartbeat)
      .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
      .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
      .execute();
  }

  // --- Training Samples ---
  public async addTrainingSample(sample: NewTrainingSample): Promise<number> {
    const [inserted] = await this.db
      .insert(trainingSamples)
      .values({
        symbol: sample.symbol,
        features: sample.features,
        label: sample.label,
      })
      .execute();
    logger.debug(`Added training sample`, { symbol: sample.symbol, label: sample.label });
    return inserted.insertId;
  }

  public async getTrainingSamples(): Promise<TrainingSample[]> {
    const samples = await this.db.select().from(trainingSamples).execute();
    return samples.map(s => ({
      ...s,
      features: typeof s.features === 'string' ? JSON.parse(s.features) : s.features,
    }));
  }

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
    await this.db.insert(simulatedTrades).values({
      ...trade,
      signalId,
      openedAt: Date.now(),
    }).execute();
    logger.debug(`Started simulated trade`, { signalId, symbol: trade.symbol });
    return signalId;
  }

  public async closeSimulatedTrade(
    signalId: string,
    outcome: 'sl' | 'tp' | 'timeout',
    pnl: number
  ): Promise<void> {
    await this.db
      .update(simulatedTrades)
      .set({
        closedAt: Date.now(),
        outcome,
        pnl,
      })
      .where(eq(simulatedTrades.signalId, signalId))
      .execute();
    logger.debug(`Closed simulated trade`, { signalId, outcome, pnl });
  }

  public async getOpenSimulatedTrades(): Promise<SimulatedTrade[]> {
    return await this.db
      .select()
      .from(simulatedTrades)
      .where(isNull(simulatedTrades.closedAt))
      .execute();
  }
}

export const dbService = new DatabaseService();
export const initializeClient = dbService.initialize.bind(dbService);
export const closeDb = dbService.close.bind(dbService);
