// src/lib/db/schema.ts
import { mysqlTable, int, varchar, timestamp, boolean, bigint, json, index } from 'drizzle-orm/mysql-core';
import { Condition } from '../../types';

/**
 * User table for storing user authentication data.
 */
export const user = mysqlTable('user', {
  id: varchar('id', { length: 255 }).primaryKey(),
  age: int('age'),
  username: varchar('username', { length: 50 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
});

/**
 * Session table for managing user sessions.
 */
export const session = mysqlTable('session', {
  id: varchar('id', { length: 255 }).primaryKey(),
  userId: varchar('user_id', { length: 255 })
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
});

/**
 * Alert table for storing user-defined trading alerts.
 */
export const alert = mysqlTable('alert', {
  id: int('id').primaryKey().autoincrement(),
  symbol: varchar('symbol', { length: 50 }).notNull(),
  conditions: json('conditions').$type<Condition[]>().notNull(),
  timeframe: varchar('timeframe', { length: 10 }).notNull().default('1h'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow(),
  note: varchar('note', { length: 255 }),
  lastAlertAt: int('last_alert_at').default(0),
});

/**
 * Locks table for preventing concurrent bot executions.
 */
export const locks = mysqlTable('locks', {
  id: int('id').primaryKey(),
  isLocked: boolean('is_locked').default(false),
});

/**
 * Heartbeat table for tracking bot scan cycles.
 */
export const heartbeat = mysqlTable('heartbeat', {
  id: int('id').primaryKey(),
  cycleCount: int('cycleCount').notNull().default(0),
  lastHeartbeatAt: bigint('lastHeartbeatAt', { mode: 'number' }).notNull().default(0),
});

/**
 * Training samples table for storing ML training data.
 */
export const trainingSamples = mysqlTable(
  'training_samples',
  {
    id: int('id').primaryKey().autoincrement(),
    symbol: varchar('symbol', { length: 50 }).notNull(),
    features: json('features').$type<number[]>().notNull(),
    label: int('label').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  table => ({
    symbolIdx: index('idx_symbol').on(table.symbol),
  })
);

/**
 * Trades table for storing executed trade records.
 */
export const trades = mysqlTable(
  'trades',
  {
    id: int('id').primaryKey().autoincrement(),
    symbol: varchar('symbol', { length: 50 }).notNull(),
    side: varchar('side', { length: 10 }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    price: bigint('price', { mode: 'number' }).notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    mode: varchar('mode', { length: 10 }).notNull(),
    orderId: varchar('order_id', { length: 50 }).notNull(),
  },
  table => ({
    symbolIdx: index('idx_symbol').on(table.symbol),
    timestampIdx: index('idx_timestamp').on(table.timestamp),
  })
);

/**
 * Simulated trades table – tracks paper-trade outcomes for ML training.
 */
export const simulatedTrades = mysqlTable(
  'simulated_trades',
  {
    id: int('id').primaryKey().autoincrement(),
    signalId: varchar('signal_id', { length: 36 }).notNull().unique(), // UUID
    symbol: varchar('symbol', { length: 50 }).notNull(),
    side: varchar('side', { length: 10 }).notNull(), // 'buy' | 'sell'
    entryPrice: bigint('entry_price', { mode: 'number' }).notNull(),
    stopLoss: bigint('stop_loss', { mode: 'number' }),
    takeProfit: bigint('take_profit', { mode: 'number' }),
    trailingDist: bigint('trailing_dist', { mode: 'number' }),
    openedAt: bigint('opened_at', { mode: 'number' }).notNull(),
    closedAt: bigint('closed_at', { mode: 'number' }),
    pnl: bigint('pnl', { mode: 'number' }),
    outcome: varchar('outcome', { length: 10 }), // 'sl' | 'tp' | 'timeout'
  },
  table => ({
    signalIdIdx: index('idx_signal_id').on(table.signalId),
    symbolIdx: index('idx_sim_symbol').on(table.symbol),
    openedAtIdx: index('idx_sim_opened').on(table.openedAt),
  })
);

/**
 * TypeScript types for type-safe database queries.
 */
export type Session = typeof session.$inferSelect;
export type User = typeof user.$inferSelect;
export type Alert = typeof alert.$inferSelect;
export type NewAlert = typeof alert.$inferInsert;
export type Lock = typeof locks.$inferSelect;
export type Heartbeat = typeof heartbeat.$inferSelect;
export type TrainingSample = typeof trainingSamples.$inferSelect;
export type NewTrainingSample = typeof trainingSamples.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type SimulatedTrade = typeof simulatedTrades.$inferSelect;
export type NewSimulatedTrade = typeof simulatedTrades.$inferInsert;
