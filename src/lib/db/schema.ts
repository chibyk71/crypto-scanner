import { mysqlTable, int, varchar, timestamp, boolean, bigint, json, index } from 'drizzle-orm/mysql-core';
import { Condition } from '../../types';

/**
 * User table for storing user authentication data.
 * - Stores unique usernames, password hashes, and optional age.
 * - Used for bot user authentication, e.g., via Telegram commands.
 * - Primary key is a unique user ID (e.g., UUID or Telegram ID).
 */
export const user = mysqlTable('user', {
  id: varchar('id', { length: 255 }).primaryKey(), // VARCHAR(255) for unique user IDs (e.g., UUIDs or Telegram IDs)
  age: int('age'), // INT for optional age, nullable by default
  username: varchar('username', { length: 50 }).notNull().unique(), // VARCHAR(50) for unique usernames
  passwordHash: varchar('password_hash', { length: 255 }).notNull(), // VARCHAR(255) for secure password hashes
});

/**
 * Session table for managing user sessions.
 * - Tracks active sessions with expiration timestamps.
 * - Links to the user table via userId foreign key with cascading deletion.
 */
export const session = mysqlTable('session', {
  id: varchar('id', { length: 255 }).primaryKey(), // VARCHAR(255) for session IDs (e.g., UUIDs)
  userId: varchar('user_id', { length: 255 })
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }), // Foreign key to user.id, cascades on delete
  expiresAt: timestamp('expires_at').notNull(), // TIMESTAMP for session expiration
});

/**
 * Alert table for storing user-defined trading alerts.
 * - Stores conditions as JSON for complex alert logic (e.g., price or volume thresholds).
 * - Tracks alert status, creation time, and last alert timestamp.
 * - Used for notifying users of market events via Telegram.
 */
export const alert = mysqlTable('alert', {
  id: int('id').primaryKey().autoincrement(), // Auto-incrementing ID for alerts
  symbol: varchar('symbol', { length: 50 }).notNull(), // Trading symbol (e.g., 'BTC/USDT')
  conditions: json('conditions').$type<Condition[]>().notNull(), // JSON array of conditions
  timeframe: varchar('timeframe', { length: 10 }).notNull().default('1h'), // Timeframe for alert (e.g., '15m', '1h')
  status: varchar('status', { length: 20 }).notNull().default('active'), // Alert status ('active', 'triggered', 'canceled')
  createdAt: timestamp('created_at').defaultNow(), // Creation timestamp
  note: varchar('note', { length: 255 }), // Optional note for alert context
  lastAlertAt: int('last_alert_at').default(0), // Unix timestamp (ms) of last alert
});

/**
 * Locks table for preventing concurrent bot executions.
 * - Ensures only one bot instance runs at a time (e.g., in cron jobs).
 * - Single row (id=1) with boolean lock status.
 */
export const locks = mysqlTable('locks', {
  id: int('id').primaryKey(), // Single lock ID (typically 1)
  isLocked: boolean('is_locked').default(false), // Lock status, defaults to false
});

/**
 * Heartbeat table for tracking bot scan cycles.
 * - Tracks cycle count and last heartbeat timestamp for monitoring bot health.
 * - Single row (id=1) for global heartbeat tracking.
 */
export const heartbeat = mysqlTable('heartbeat', {
  id: int('id').primaryKey(), // Single heartbeat ID (typically 1)
  cycleCount: int('cycleCount').notNull().default(0), // Number of scan cycles
  lastHeartbeatAt: bigint('lastHeartbeatAt', { mode: 'number' }).notNull().default(0), // Unix timestamp (ms) of last heartbeat
});

/**
 * Training samples table for storing ML training data.
 * - Stores features and labels for ML model training, used in online learning.
 * - Indexed by symbol for efficient querying.
 * - Tracks creation time for data analysis.
 */
export const trainingSamples = mysqlTable(
  'training_samples',
  {
    id: int('id').primaryKey().autoincrement(), // Auto-incrementing ID for samples
    symbol: varchar('symbol', { length: 50 }).notNull(), // Trading symbol (e.g., 'BTC/USDT')
    features: json('features').$type<number[]>().notNull(), // JSON array of feature values
    label: int('label').notNull(), // Label (e.g., 1 for win, -1 for loss)
    createdAt: timestamp('created_at').defaultNow(), // Creation timestamp
  },
  table => ({
    symbolIdx: index('idx_symbol').on(table.symbol), // Index on symbol for fast queries
  })
);

/**
 * Trades table for storing executed trade records.
 * - Stores trade details for performance tracking and ML training.
 * - Indexed by symbol and timestamp for efficient querying.
 * - Tracks trade mode (testnet or live) and order ID.
 */
export const trades = mysqlTable(
  'trades',
  {
    id: int('id').primaryKey().autoincrement(), // Auto-incrementing ID for trades
    symbol: varchar('symbol', { length: 50 }).notNull(), // Trading symbol (e.g., 'BTC/USDT')
    side: varchar('side', { length: 10 }).notNull(), // Trade side ('buy' or 'sell')
    amount: bigint('amount', { mode: 'number' }).notNull(), // Trade amount (in base asset)
    price: bigint('price', { mode: 'number' }).notNull(), // Trade price (in quote asset)
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(), // Unix timestamp (ms) of trade
    mode: varchar('mode', { length: 10 }).notNull(), // Trade mode ('testnet' or 'live')
    orderId: varchar('order_id', { length: 50 }).notNull(), // Exchange order ID
  },
  table => ({
    symbolIdx: index('idx_symbol').on(table.symbol), // Index on symbol for fast queries
    timestampIdx: index('idx_timestamp').on(table.timestamp), // Index on timestamp for range queries
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
