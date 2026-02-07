// src/lib/db/schema.ts
import { mysqlTable, int, varchar, timestamp, boolean, bigint, json, index, float, decimal, uniqueIndex } from 'drizzle-orm/mysql-core';
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
 * =============================================================================
 *
 * Custom user-defined alerts allow traders to be notified when specific market
 * conditions are met on a chosen symbol and timeframe.
 *
 * Features:
 *   • Flexible JSON conditions (multiple AND logic)
 *   • Cooldown via lastAlertAt to prevent spam
 *   • Status tracking (active/triggered/canceled)
 *   • Optional note for user reference
 *
 * Used by:
 *   • TelegramBotController – create/edit/delete via commands
 *   • MarketScanner – evaluates conditions every cycle
 *   • AlertEvaluatorService – actual condition checking
 */
export const alert = mysqlTable('alert', {
    /** Auto-incrementing primary key */
    id: int('id').primaryKey().autoincrement(),

    /** Trading pair (e.g., 'BTC/USDT') – required */
    symbol: varchar('symbol', { length: 50 }).notNull(),

    /** Array of conditions in JSON format – parsed to Condition[] in TypeScript */
    conditions: json('conditions').$type<Condition[]>().notNull(),

    /** Timeframe for evaluation (e.g., '1h', '15m') – defaults to 1h */
    timeframe: varchar('timeframe', { length: 10 }).notNull().default('1h'),

    /** Current status – 'active' = monitored, 'triggered'/'canceled' = inactive */
    status: varchar('status', { length: 20 }).notNull().default('active'),

    /** When the alert was created */
    createdAt: timestamp('created_at').defaultNow(),

    /** Optional free-text note from the user (e.g., "Watch for breakout") */
    note: varchar('note', { length: 255 }),

    /** Unix millisecond timestamp of last trigger – used for cooldown/throttling */
    lastAlertAt: bigint('last_alert_at', { mode: 'number' }).default(0),
});

/**
 * =============================================================================
 * BOT CONTROL TABLES
 * =============================================================================
 *
 * These singleton tables prevent multiple bot instances from running simultaneously
 * and track scan cycle progress.
 */

/**
 * Singleton lock table – ensures only one bot instance runs at a time
 *
 * Design:
 *   • Fixed id = 1 (singleton row)
 *   • isLocked = true → another instance holds the lock
 *   • Worker checks this on startup and sets to true when running
 *   • Graceful shutdown sets to false
 */
export const locks = mysqlTable('locks', {
    /** Fixed primary key – only one row ever exists */
    id: int('id').primaryKey(),

    /** Lock state – true = bot running, false = idle */
    isLocked: boolean('is_locked').notNull().default(false),
});

/**
 * Heartbeat table – tracks scan cycles and last activity
 *
 * Purpose:
 *   • Monitor bot health and uptime
 *   • Send periodic heartbeat messages via Telegram
 *   • Detect stalled/crashed workers
 *
 * Fields:
 *   • cycleCount – total completed scan cycles
 *   • lastHeartbeatAt – timestamp of most recent cycle
 */
export const heartbeat = mysqlTable('heartbeat', {
    /** Fixed primary key – singleton row */
    id: int('id').primaryKey(),

    /** Running count of completed full market scan cycles */
    cycleCount: int('cycle_count').notNull().default(0),

    /** Unix millisecond timestamp of last completed cycle */
    lastHeartbeatAt: bigint('last_heartbeat_at', { mode: 'number' }).notNull().default(0),
});

export const ohlcvHistory = mysqlTable('ohlcv_history', {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    symbol: varchar('symbol', { length: 30 }).notNull(),
    timeframe: varchar('timeframe', { length: 10 }).notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(), // Unix ms
    open: decimal('open', { precision: 30, scale: 10 }).notNull(),
    high: decimal('high', { precision: 30, scale: 10 }).notNull(),
    low: decimal('low', { precision: 30, scale: 10 }).notNull(),
    close: decimal('close', { precision: 30, scale: 10 }).notNull(),
    volume: decimal('volume', { precision: 30, scale: 8 }).notNull(),
},
    (table) => ({
        // Prevent duplicates
        uniqueIdx: uniqueIndex('unique_candle').on(table.symbol, table.timeframe, table.timestamp),
        // Fast range queries
        symbolTimeIdx: index('idx_symbol_time').on(table.symbol, table.timeframe, table.timestamp),
    })
);

/**
 * =============================================================================
 * ML TRAINING SAMPLES
 * =============================================================================
 *
 * Stores feature vectors and final 5-tier labels (-2 to +2) from simulated trades.
 * This is the primary dataset used to train the Random Forest model.
 *
 * Key features:
 *   • features: JSON array of normalized numbers (parsed to number[] in TS)
 *   • label: -2 (big loss) → +2 (strong win) based on R-multiple
 *   • Indexes on symbol, label, and createdAt for fast analytics and retraining
 *
 * Used by:
 *   • MLService – training, prediction, and performance reporting
 *   • DatabaseService – ingestion after every simulation
 */
export const trainingSamples = mysqlTable(
    'training_samples',
    {
        /** Auto-incrementing primary key */
        id: int('id').primaryKey().autoincrement(),

        /** Trading symbol the sample came from – for per-symbol analysis */
        symbol: varchar('symbol', { length: 50 }).notNull(),

        /** Normalized feature vector – stored as JSON, parsed to number[] */
        features: json('features').$type<number[]>().notNull(),

        /** Final 5-tier outcome label (-2 to +2) */
        label: int('label').notNull(),

        /** When the sample was created (simulation close time) */
        createdAt: timestamp('created_at').defaultNow(),
    },
    (table) => ({
        /** Index for per-symbol performance queries */
        symbolIdx: index('idx_training_symbol').on(table.symbol),

        /** Index for label distribution queries */
        labelIdx: index('idx_training_label').on(table.label),

        /** Index for chronological retrieval */
        createdAtIdx: index('idx_training_created').on(table.createdAt),
    })
);

/**
 * =============================================================================
 * EXECUTED TRADES (LIVE OR PAPER)
 * =============================================================================
 *
 * Permanent log of all real executed trades (live or paper/testnet mode).
 *
 * Purpose:
 *   • Audit trail
 *   • Performance tracking
 *   • Future tax/export needs
 *
 * All monetary values stored with high precision (×1e8 internally)
 *
 * Used by:
 *   • AutoTradeService – after placing live orders
 *   • TelegramBot – /trades command
 */
export const trades = mysqlTable(
    'trades',
    {
        id: int('id').primaryKey().autoincrement(),

        symbol: varchar('symbol', { length: 50 }).notNull(),
        side: varchar('side', { length: 10 }).notNull(), // 'buy' | 'sell'

        /** Quantity ×1e8 for precision (avoids floating point issues) */
        amount: float('amount').notNull(),

        /** Entry price ×1e8 */
        price: float('price').notNull(),

        /** Unix millisecond timestamp */
        timestamp: bigint('timestamp', { mode: 'number' }).notNull(),

        /** 'live' or 'paper' – distinguishes real vs test trades */
        mode: varchar('mode', { length: 10 }).notNull(),

        /** Exchange order ID for reconciliation */
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
 * =============================================================================
 *
 * Records every simulated trade with full outcome details.
 * This is the source of truth for ML training labels and excursion metrics.
 *
 * High-precision storage:
 *   • All prices/distances: ×1e8
 *   • MFE/MAE: ×1e4 (percentage of entry price)
 *   • PnL: ×1e8
 *   • R-multiple: ×1e4
 *
 * Supports:
 *   • Partial take-profits (multiple levels)
 *   • Trailing stops
 *   • Timeout exits
 *   • Max Favorable/Adverse Excursion tracking
 */
export const simulatedTrades = mysqlTable(
    'simulated_trades',
    {
        id: int('id').primaryKey().autoincrement(),

        /** UUID linking open → close operations */
        signalId: varchar('signal_id', { length: 36 }).notNull().unique(),

        symbol: varchar('symbol', { length: 50 }).notNull(),
        side: varchar('side', { length: 10 }).$type<'buy' | 'sell'>().notNull(), // 'buy' | 'sell'

        /** Entry price ×1e8 */
        entryPrice: float('entry_price').notNull(),

        stopLoss: float('stop_loss'),                    // Fixed SL ×1e8
        trailingDist: float('trailing_dist'),            // Trailing distance ×1e8

        /** Partial TP levels – array of { price ×1e8, weight } */
        tpLevels: json('tp_levels').$type<{ price: number; weight: number }[]>(),

        openedAt: bigint('opened_at', { mode: 'number' }).notNull(),
        closedAt: bigint('closed_at', { mode: 'number' }),

        outcome: varchar('outcome', { length: 15 }),     // 'tp', 'partial_tp', 'sl', 'timeout'

        /** Realized PnL ×1e8 */
        pnl: bigint('pnl', { mode: 'number' }).notNull(),

        /** R-multiple ×1e4 */
        rMultiple: bigint('r_multiple', { mode: 'number' }),

        /** Final 5-tier label for ML */
        label: int('label'),

        /** Max Favorable Excursion as % ×1e4 */
        maxFavorableExcursion: bigint('mfe', { mode: 'number' }),

        /** Max Adverse Excursion as % ×1e4 */
        maxAdverseExcursion: bigint('mae', { mode: 'number' }),

        durationMs: bigint('duration_ms', { mode: 'number' }).default(0),
        timeToMFEMs: bigint('time_to_mfe_ms', { mode: 'number' }).default(0),
        timeToMAEMs: bigint('time_to_mae_ms', { mode: 'number' }).default(0),
    },
    (table) => ({
        signalIdIdx: index('idx_sim_signal_id').on(table.signalId),
        symbolIdx: index('idx_sim_symbol').on(table.symbol),
        openedAtIdx: index('idx_sim_opened').on(table.openedAt),
        outcomeIdx: index('idx_sim_outcome').on(table.outcome),
        labelIdx: index('idx_sim_label').on(table.label),
        closedAtIdx: index('idx_sim_closed').on(table.closedAt),
        durationIdx: index('idx_sim_duration').on(table.durationMs),
    })
);

/**
 * =============================================================================
 * COOLDOWN TABLE – PER-SYMBOL THROTTLING
 * =============================================================================
 *
 * Prevents signal/trade spam on the same symbol.
 * One row per symbol with last action timestamp.
 *
 * Used by:
 *   • MarketScanner – cooldown between signals
 *   • Custom alerts – throttle notifications
 */
export const coolDownTable = mysqlTable('cool_down', {
    id: int('id').primaryKey().autoincrement(),

    /** Unique per symbol – ensures only one row exists */
    symbol: varchar('symbol', { length: 15 }).unique(),

    /** Last trade or alert timestamp (Unix ms) */
    lastTradeAt: bigint('last_trade_at', { mode: 'number' }).notNull(),
});

/**
 * =============================================================================
 * TYPE INFERENCE (TypeScript magic)
 * =============================================================================
 *
 * Drizzle automatically generates TypeScript types from table definitions.
 * These types are used throughout the app for:
 *   • Type-safe database queries
 *   • Insert/update operations
 *   • API responses and internal data flow
 *
 * Benefits:
 *   • No manual type duplication
 *   • Instant refactor safety
 *   • Full IDE autocomplete and error checking
 */
export type Session = typeof session.$inferSelect;
export type User = typeof user.$inferSelect;

export type Alert = typeof alert.$inferSelect;
export type NewAlert = typeof alert.$inferInsert;

export type Lock = typeof locks.$inferSelect;
export type Heartbeat = typeof heartbeat.$inferSelect;

export type CoolDown = typeof coolDownTable.$inferSelect;
export type NewCoolDown = typeof coolDownTable.$inferInsert;

export type TrainingSample = typeof trainingSamples.$inferSelect;
export type NewTrainingSample = typeof trainingSamples.$inferInsert;

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;

export type OhlcvHistory = typeof ohlcvHistory.$inferSelect;
export type NewOhlcvHistory = typeof ohlcvHistory.$inferInsert;

/** Full simulated trade with all fields */
export type SimulatedTrade = typeof simulatedTrades.$inferSelect;
/** Data for starting a new simulation (excludes auto-generated fields) */
export type NewSimulatedTrade = Omit<
    typeof simulatedTrades.$inferInsert,
    'signalId' | 'openedAt' | 'closedAt' | 'outcome' | 'pnl' | 'rMultiple' | 'label' | 'maxFavorableExcursion' | 'maxAdverseExcursion'
>;
