// src/lib/db/repositories/watchAlerts/writePath.ts
// Write-side operations for watch_alerts and trending_notifications.

import { eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import {
    watchAlerts,
    trendingNotifications,
    type NewWatchAlertRow,
} from '../../schema';
import type {
    ResolvedReason,
    WatchAlertStatus,
} from '../../../../../watch-alerts-export/src/lib/watchAlerts/types';

type Db = MySql2Database<any>;

/**
 * Insert a new watch alert. Returns the auto-increment id.
 */
export async function createWatchAlert(
    db: Db,
    row: NewWatchAlertRow
): Promise<number> {
    const [result] = await db.insert(watchAlerts).values(row).execute();
    return result.insertId;
}

/**
 * Transition an alert out of active status (triggered / invalidated / expired).
 */
export async function updateWatchAlertStatus(
    db: Db,
    id: number,
    status: WatchAlertStatus,
    opts: {
        resolvedAt: number;
        resolvedReason: ResolvedReason;
        triggeredPrice?: number | null;
    }
): Promise<boolean> {
    const result = await db
        .update(watchAlerts)
        .set({
            status,
            resolvedAt: opts.resolvedAt,
            resolvedReason: opts.resolvedReason,
            ...(opts.triggeredPrice !== undefined
                ? { triggeredPrice: opts.triggeredPrice }
                : {}),
        })
        .where(eq(watchAlerts.id, id))
        .execute();

    return result[0].affectedRows > 0;
}

/**
 * Upsert last trending-notification timestamp for a symbol.
 */
export async function recordTrendingNotification(
    db: Db,
    symbol: string,
    lastNotifiedAt: number
): Promise<void> {
    // Try update first; if no row, insert
    const updated = await db
        .update(trendingNotifications)
        .set({ lastNotifiedAt })
        .where(eq(trendingNotifications.symbol, symbol))
        .execute();

    const affected = updated[0].affectedRows ?? 0;

    if (affected === 0) {
        await db
            .insert(trendingNotifications)
            .values({ symbol, lastNotifiedAt })
            .execute();
    }
}
