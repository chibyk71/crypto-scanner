import { mysqlTable, int, varchar, timestamp, boolean, bigint, json } from 'drizzle-orm/mysql-core';
import { Condition } from '../../types';

/**
 * User table for storing user authentication data.
 * - Stores unique usernames, password hashes, and optional age.
 * - Used for bot user authentication (e.g., via Telegram commands).
 */
export const user = mysqlTable('user', {
    id: varchar('id', { length: 255 }).primaryKey(), // VARCHAR(255) for unique user IDs (e.g., UUIDs or Telegram IDs).
    age: int('age'), // INT for optional age, nullable by default.
    username: varchar('username', { length: 50 }).notNull().unique(), // VARCHAR(50) for unique usernames.
    passwordHash: varchar('password_hash', { length: 255 }).notNull(), // VARCHAR(255) for secure password hashes.
});

/**
 * Session table for managing user sessions.
 * - Tracks active sessions with expiration timestamps.
 * - Links to the user table via userId foreign key.
 */
export const session = mysqlTable('session', {
    id: varchar('id', { length: 255 }).primaryKey(), // VARCHAR(255) for session IDs (e.g., UUIDs).
    userId: varchar('user_id', { length: 255 })
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }), // Foreign key to user.id, cascades on delete.
    expiresAt: timestamp('expires_at').notNull(), // TIMESTAMP for session expiration.
});

/**
 * Alert table for storing user-defined alerts.
 * - Supports complex conditions using JSON.
 * - Tracks status, creation time, and last alert time.
 * - Used for notifying users based on specific criteria (e.g., price movements).
 */
export const alert = mysqlTable('alert', {
    id: int('id').primaryKey().autoincrement(),
    symbol: varchar('symbol', { length: 50 }).notNull(),
    conditions: json('conditions').$type<Condition[]>().notNull(), // JSON for complex conditions (e.g., [{type: 'price', operator: '>', value: 3.54}, {type: 'volume', operator: '>', value: 1000000}])
    timeframe: varchar('timeframe', { length: 10 }).notNull().default('1h'), // e.g., '15m', '1h'
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at').defaultNow(),
    note: varchar('note', { length: 255 }),
    lastAlertAt: int('last_alert_at').default(0),
});

/**
 * Locks table for preventing concurrent bot executions.
 * - Used in index-github.ts to ensure single-scan runs in cron jobs.
 * - Single row (id=1) with boolean lock status.
 */
export const locks = mysqlTable('locks', {
    id: int('id').primaryKey(), // INT for unique lock ID (typically 1).
    isLocked: boolean('is_locked').default(false), // BOOLEAN for lock status, defaults to false.
});

export const heartbeat = mysqlTable('heartbeat', {
    id: int('id').primaryKey(),
    cycleCount: int('cycleCount').notNull().default(0),
    lastHeartbeatAt: bigint('lastHeartbeatAt', { mode: 'number' })
});

/**
 * TypeScript types for type-safe queries in db/index.ts.
 * - Session: Represents a session row.
 * - User: Represents a user row.
 * - Alert: Represents an alert row (for select queries).
 * - NewAlert: Represents an alert insert (no ID, as it's auto-incremented).
 * - Lock: Represents a lock row.
 */
export type Session = typeof session.$inferSelect;
export type User = typeof user.$inferSelect;
export type Alert = typeof alert.$inferSelect;
export type NewAlert = typeof alert.$inferInsert;
export type Lock = typeof locks.$inferSelect;
export type Heartbeat = typeof heartbeat.$inferSelect;
