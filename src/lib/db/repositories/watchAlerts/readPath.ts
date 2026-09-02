// src/lib/db/repositories/watchAlerts/readPath.ts
// Read-side operations for watch_alerts and trending_notifications.

import { eq, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';

import type {
    ConditionNode,
    TradePlanSpec,
    WatchAlert,
    WatchAlertStatus,
} from '../../../services/watchAlerts/types';
import { trendingNotifications, watchAlerts } from '../../schema';

type Db = MySql2Database<any>;

function mapRow(row: typeof watchAlerts.$inferSelect): WatchAlert {
    return {
        id: row.id,
        symbol: row.symbol,
        thesis: row.thesis,
        confidence: row.confidence as WatchAlert['confidence'],
        status: row.status as WatchAlertStatus,
        entryConditions:
            typeof row.entryConditions === 'string'
                ? (JSON.parse(row.entryConditions) as ConditionNode)
                : (row.entryConditions as ConditionNode),
        invalidateConditions: row.invalidateConditions
            ? typeof row.invalidateConditions === 'string'
                ? (JSON.parse(row.invalidateConditions) as ConditionNode)
                : (row.invalidateConditions as ConditionNode)
            : null,
        tradePlan:
            typeof row.tradePlan === 'string'
                ? (JSON.parse(row.tradePlan) as TradePlanSpec)
                : (row.tradePlan as TradePlanSpec),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        resolvedAt: row.resolvedAt ?? null,
        resolvedReason: (row.resolvedReason as WatchAlert['resolvedReason']) ?? null,
        triggeredPrice: row.triggeredPrice ?? null,
    };
}

/**
 * All alerts currently in status = 'active'.
 */
export async function getActiveWatchAlerts(db: Db): Promise<WatchAlert[]> {
    const rows = await db
        .select()
        .from(watchAlerts)
        .where(eq(watchAlerts.status, 'active'))
        .execute();

    return rows.map(mapRow);
}

/**
 * Count of active alerts (for MAX_CONCURRENT_ACTIVE_ALERTS enforcement).
 */
export async function countActiveWatchAlerts(db: Db): Promise<number> {
    const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(watchAlerts)
        .where(eq(watchAlerts.status, 'active'))
        .execute();

    return Number(rows[0]?.count ?? 0);
}

/**
 * Fetch a single watch alert by primary key.
 */
export async function getWatchAlertById(
    db: Db,
    id: number
): Promise<WatchAlert | undefined> {
    const rows = await db
        .select()
        .from(watchAlerts)
        .where(eq(watchAlerts.id, id))
        .execute();

    if (rows.length === 0) return undefined;
    return mapRow(rows[0]);
}

/**
 * Last trending-notification timestamp for a symbol, or null if never notified.
 */
export async function getLastTrendingNotification(
    db: Db,
    symbol: string
): Promise<number | null> {
    const rows = await db
        .select()
        .from(trendingNotifications)
        .where(eq(trendingNotifications.symbol, symbol))
        .execute();

    if (rows.length === 0) return null;
    return rows[0].lastNotifiedAt;
}
