// src/lib/db/schema.ts
import { mysqlTable, int, varchar, timestamp, boolean, bigint, json, index, float, } from 'drizzle-orm/mysql-core';
import type { Condition } from '../../types';

/**
 * =============================================================================
 * USER & AUTH TABLES
 * =============================================================================
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
 * =============================================================================
 * ALERT SYSTEM
 *  Alert table for storing user-defined trading alerts.=============================================================================
 */
export const alert = mysqlTable('alert', {
    id: int('id').primaryKey().autoincrement(),
    symbol: varchar('symbol', { length: 50 }).notNull(),
    conditions: json('conditions').$type<Condition[]>().notNull(),
    timeframe: varchar('timeframe', { length: 10 }).notNull().default('1h'),
    status: varchar('status', { length: 20 }).notNull().default('active'), // active, triggered, canceled
    createdAt: timestamp('created_at').defaultNow(),
    note: varchar('note', { length: 255 }),
    lastAlertAt: bigint('last_alert_at', { mode: 'number' }).default(0), // epoch ms
});

/**
 * =============================================================================
 * BOT CONTROL TABLES
 * =============================================================================
 */

/**
 * Locks table for preventing concurrent bot executions.
 */
export const locks = mysqlTable('locks', {
    id: int('id').primaryKey(), // singleton row, id = 1
    isLocked: boolean('is_locked').notNull().default(false),
});

/**
 * Heartbeat table for tracking bot scan cycles.
 */
export const heartbeat = mysqlTable('heartbeat', {
    id: int('id').primaryKey(), // singleton row, id = 1
    cycleCount: int('cycle_count').notNull().default(0),
    lastHeartbeatAt: bigint('last_heartbeat_at', { mode: 'number' }).notNull().default(0),
});

/**
 * =============================================================================
 * ML TRAINING SAMPLES
 * Stores feature vectors + final 5-tier label (-2 to +2)
 * Used directly for Random Forest / XGBoost training
 * =============================================================================
 */
export const trainingSamples = mysqlTable(
    'training_samples',
    {
        id: int('id').primaryKey().autoincrement(),
        symbol: varchar('symbol', { length: 50 }).notNull(),
        features: json('features').$type<number[]>().notNull(), // normalized float array
        label: int('label').notNull(), // -2 = big loss, -1 = loss, 0 = neutral, 1 = win, 2 = strong win
        createdAt: timestamp('created_at').defaultNow(),
    },
    (table) => ({
        symbolIdx: index('idx_training_symbol').on(table.symbol),
        labelIdx: index('idx_training_label').on(table.label),
        createdAtIdx: index('idx_training_created').on(table.createdAt),
    })
);

/**
 * =============================================================================
 * EXECUTED TRADES (LIVE OR PAPER)
 * =============================================================================
 */
export const trades = mysqlTable(
    'trades',
    {
        id: int('id').primaryKey().autoincrement(),
        symbol: varchar('symbol', { length: 50 }).notNull(),
        side: varchar('side', { length: 10 }).notNull(), // 'buy' | 'sell'
        amount: float('amount').notNull(), // raw quantity × 1e8 (for precision)
        price: float('price').notNull(),   // price × 1e8
        timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
        mode: varchar('mode', { length: 10 }).notNull(), // 'live' | 'paper'
        orderId: varchar('order_id', { length: 50 }).notNull(),
    },
    (table) => ({
        symbolIdx: index('idx_trades_symbol').on(table.symbol),
        timestampIdx: index('idx_trades_timestamp').on(table.timestamp),
    })
);

/**
 * =============================================================================
 * SIMULATED TRADES – CORE OF ML LABELING ENGINE
 *
 * This table stores every simulated trade outcome with:
 * • Partial take-profits (multiple levels)
 * • Trailing stop support
 * • Max Favorable/Adverse Excursion (MFE/MAE)
 * • R-multiple & final 5-tier label
 *
 * All monetary values stored as integers × 1e8 (8 decimals) → no floating point errors
 * =============================================================================
 */
export const simulatedTrades = mysqlTable(
    'simulated_trades',
    {
        id: int('id').primaryKey().autoincrement(),

        // Unique identifier for in-memory tracking
        signalId: varchar('signal_id', { length: 36 }).notNull().unique(), // UUID v4

        symbol: varchar('symbol', { length: 50 }).notNull(),
        side: varchar('side', { length: 10 }).notNull(), // 'buy' | 'sell'

        // Entry
        entryPrice: float('entry_price').notNull(), // × 1e8

        // Risk Management
        stopLoss: float('stop_loss'),           // fixed SL × 1e8
        trailingDist: float('trailing_dist'),   // trailing distance × 1e8

        // Multiple Take-Profit Levels (partial fills)
        // Example: [{ price: 65000, weight: 0.5 }, { price: 68000, weight: 0.5 }]
        tpLevels: json('tp_levels').$type<{ price: number; weight: number }[]>(),

        // Timestamps
        openedAt: bigint('opened_at', { mode: 'number' }).notNull(),
        closedAt: bigint('closed_at', { mode: 'number' }),

        // Outcome
        outcome: varchar('outcome', { length: 15 }), // 'tp' | 'partial_tp' | 'sl' | 'timeout'

        // Results
        pnl: bigint('pnl', { mode: 'number' }).notNull(),                 // realized PnL × 1e8 (e.g. 0.0567 → 5670000)
        rMultiple: bigint('r_multiple', { mode: 'number' }),              // × 1e4 (e.g. 2.374 → 23740)

        // ML Label: stored directly → no recompute needed during training
        label: int('label'), // -2 | -1 | 0 | 1 | 2

        // Excursion Metrics (extremely powerful features for ML)
        maxFavorableExcursion: bigint('mfe', { mode: 'number' }), // best unrealion price movement × 1e8
        maxAdverseExcursion: bigint('mae', { mode: 'number' }),   // worst price movement × 1e8
    },
    (table) => ({
        signalIdIdx: index('idx_sim_signal_id').on(table.signalId),
        symbolIdx: index('idx_sim_symbol').on(table.symbol),
        openedAtIdx: index('idx_sim_opened').on(table.openedAt),
        outcomeIdx: index('idx_sim_outcome').on(table.outcome),
        labelIdx: index('idx_sim_label').on(table.label),
        closedAtIdx: index('idx_sim_closed').on(table.closedAt),
    })
);

export const coolDownTable = mysqlTable('cool_down', {
    id: int('id').primaryKey().autoincrement(),
    symbol: varchar('symbol', {length: 15}).unique(),
    lastTradeAt: bigint('last_trade_at', {mode: 'number'}).notNull(),
})

/**
 * =============================================================================
 * TYPE INFERENCE (TypeScript magic)
 * =============================================================================
 */
export type Session = typeof session.$inferSelect;
export type User = typeof user.$inferSelect;

export type Alert = typeof alert.$inferSelect;
export type NewAlert = typeof alert.$inferInsert;

export type Lock = typeof locks.$inferSelect;
export type Heartbeat = typeof heartbeat.$inferSelect;

export type CoolDown = typeof coolDownTable.$inferSelect;
export  type NewCoolDown = typeof coolDownTable.$inferInsert;

export type TrainingSample = typeof trainingSamples.$inferSelect;
export type NewTrainingSample = typeof trainingSamples.$inferInsert;

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;

export type SimulatedTrade = typeof simulatedTrades.$inferSelect;
export type NewSimulatedTrade = Omit<
    typeof simulatedTrades.$inferInsert,
    'signalId' | 'openedAt' | 'closedAt' | 'outcome' | 'pnl' | 'rMultiple' | 'label' | 'maxFavorableExcursion' | 'maxAdverseExcursion'
>;
