import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
    id: text('id').primaryKey(),
    age: integer('age'),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull()
});

export const session = sqliteTable('session', {
    id: text('id').primaryKey(),
    userId: text('user_id')
        .notNull()
        .references(() => user.id),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull()
});

export const alert = sqliteTable('alert', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    condition: text('condition').notNull(), // e.g., 'price >', 'price <', 'crosses_above_ema200', 'crosses_below_ema200'
    targetPrice: real('target_price').notNull(),
    status: text('status').notNull().default('active'), // 'active', 'triggered', 'canceled'
    createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
    note: text('note'), // Optional user note
    lastAlertAt: integer('last_alert_at') // Timestamp for last alert (for GitHub Actions cooldowns)
});

export const locks = sqliteTable('locks', {
    id: integer('id').primaryKey(),
    isLocked: integer('is_locked', { mode: 'boolean' })
});

export type Session = typeof session.$inferSelect;
export type User = typeof user.$inferSelect;
export type Alert = typeof alert.$inferSelect;
export type NewAlert = typeof alert.$inferInsert;
export type Lock = typeof locks.$inferSelect;
