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
 * SIMULATED TRADES – SINGLE SOURCE OF TRUTH FOR SIMULATIONS & ML TRAINING
 * =============================================================================
 *
 * This table records **every simulated trade** from signal generation to outcome.
 * It now serves as the **sole source** for:
 *   - Simulation results (PnL, outcome, excursions, duration, etc.)
 *   - Machine learning training data (when label IS NOT NULL)
 *
 * Important notes (2026 reality after removing training_samples table):
 *   - No duplication: features, label, MFE/MAE, duration, etc. live only here
 *   - ML training queries: SELECT * FROM simulated_trades WHERE label IS NOT NULL
 *   - No extra flag needed: presence of label indicates row is usable for training
 *   - Retention: consider adding cleanup job (e.g. delete rows >90 days old)
 *
 * High-precision storage rules:
 *   • Prices, distances, PnL           → ×1e8 (float or bigint)
 *   • Percentages (MFE/MAE, R-multiple) → ×1e4 (bigint)
 *   • Timestamps                        → Unix ms (bigint)
 *   • JSON arrays                       → structured objects/arrays
 *
 * Indexes are optimized for:
 *   - Fast lookup by signalId (unique)
 *   - Per-symbol queries (recent simulations, regime calculation)
 *   - Filtering by outcome/label/closed time (ML training, reporting)
 */
export const simulatedTrades = mysqlTable(
    'simulated_trades',
    {
        /** Auto-incrementing primary key */
        id: int('id').primaryKey().autoincrement(),

        /**
         * UUID linking signal generation → simulation close
         * Used to correlate logs, alerts, and database rows
         */
        signalId: varchar('signal_id', { length: 36 }).notNull().unique(),

        /** Trading pair (e.g. 'BTC/USDT', 'ETH/USDT') */
        symbol: varchar('symbol', { length: 50 }).notNull(),

        /** Trade direction */
        side: varchar('side', { length: 10 }).$type<'buy' | 'sell'>().notNull(),

        /** Entry price ×1e8 (high precision) */
        entryPrice: float('entry_price').notNull(),

        /** Fixed stop-loss price ×1e8 (nullable if no SL) */
        stopLoss: float('stop_loss'),

        /** Trailing stop distance ×1e8 (nullable if no trailing) */
        trailingDist: float('trailing_dist'),

        /**
         * Partial take-profit levels
         * Array of objects: { price: number ×1e8, weight: number (0-1) }
         */
        tpLevels: json('tp_levels').$type<{ price: number; weight: number }[] | null>(),

        /** Unix ms timestamp when simulation started */
        openedAt: bigint('opened_at', { mode: 'number' }).notNull(),

        /** Unix ms timestamp when simulation ended (TP/SL/timeout) */
        closedAt: bigint('closed_at', { mode: 'number' }),

        /**
         * Final outcome of the simulated trade
         * - 'tp'         : full take-profit hit
         * - 'partial_tp' : partial TP(s) hit
         * - 'sl'         : stop-loss hit
         * - 'timeout'    : reached max duration without exit
         */
        outcome: varchar('outcome', { length: 15 }),

        /** Realized PnL ×1e8 */
        pnl: bigint('pnl', { mode: 'number' }).notNull(),

        /** Risk-adjusted return (PnL / initial risk) ×1e4 */
        rMultiple: bigint('r_multiple', { mode: 'number' }),

        /**
         * Final ML training label (-2 to +2)
         * NULL = simulation still open or not labeled
         * NOT NULL = ready for ML training / regime stats
         */
        label: int('label'),

        /** Max Favorable Excursion (% of entry) ×1e4 */
        maxFavorableExcursion: bigint('mfe', { mode: 'number' }).default(0),

        /** Max Adverse Excursion (% of entry) ×1e4 */
        maxAdverseExcursion: bigint('mae', { mode: 'number' }).default(0),

        /** Total duration of the simulation in milliseconds */
        durationMs: bigint('duration_ms', { mode: 'number' }).default(0),

        /** Time from entry to max favorable excursion (ms) */
        timeToMFEMs: bigint('time_to_mfe_ms', { mode: 'number' }).default(0),

        /** Time from entry to max adverse excursion (ms) */
        timeToMAEMs: bigint('time_to_mae_ms', { mode: 'number' }).default(0),

        /**
         * Feature vector used at signal time (indicators + regime stats)
         * Stored as JSON array of numbers
         * Only populated for rows where label IS NOT NULL
         */
        features: json('features').$type<number[] | null>(),
    },
    (table) => ({
        /** Fast lookup by signal UUID */
        signalIdIdx: index('idx_sim_signal_id').on(table.signalId),

        /** Per-symbol queries (recent trades, regime stats) */
        symbolIdx: index('idx_sim_symbol').on(table.symbol),

        /** Time-based filtering (recent simulations) */
        openedAtIdx: index('idx_sim_opened').on(table.openedAt),

        /** Outcome filtering (e.g. only timeouts or SLs) */
        outcomeIdx: index('idx_sim_outcome').on(table.outcome),

        /** ML training filter + per-symbol label stats */
        labelIdx: index('idx_sim_label').on(table.symbol, table.label),

        /** Closed time for recent results / cache warm-up */
        closedAtIdx: index('idx_sim_closed').on(table.closedAt),

        /** Duration queries / long-trade detection */
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
