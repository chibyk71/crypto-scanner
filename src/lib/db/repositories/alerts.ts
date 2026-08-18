// src/lib/db/repositories/alerts.ts
// Alert CRUD operations

import { and, eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { alert, type Alert, type NewAlert } from '../schema';
import { createLogger } from '../../logger';

const logger = createLogger('db:alerts');

type Db = MySql2Database<any>;

/**
 * Retrieves all currently active custom alerts from the database.
 *
 * Used by:
 *   • MarketScanner – to evaluate user-defined conditions every scan cycle
 *   • TelegramBot – to list alerts via /alerts command
 */
export async function getActiveAlerts(db: Db): Promise<Alert[]> {
    const rows = await db
        .select()
        .from(alert)
        .where(eq(alert.status, 'active'))
        .execute();

    return rows.map(a => ({
        ...a,
        conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
    }));
}

/**
 * Inserts a new user-defined alert into the database.
 *
 * Called from:
 *   • TelegramBotController – when user completes /create_alert flow
 */
export async function createAlert(db: Db, alertData: NewAlert): Promise<number> {
    const [result] = await db.insert(alert).values(alertData).execute();
    logger.debug('Created new alert', { id: result.insertId, symbol: alertData.symbol });
    return result.insertId;
}

/**
 * Gets all active alerts for a given trading symbol.
 */
export async function getAlertsBySymbol(db: Db, symbol: string): Promise<Alert[]> {
    const alerts = await db
        .select()
        .from(alert)
        .where(and(eq(alert.symbol, symbol), eq(alert.status, 'active')))
        .execute();

    return alerts.map(a => ({
        ...a,
        conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
    }));
}

/**
 * Retrieves a specific alert by its primary key (ID).
 */
export async function getAlertsById(db: Db, id: number): Promise<Alert | undefined> {
    const result = await db.select().from(alert).where(eq(alert.id, id)).execute();
    if (result.length === 0) return undefined;

    const a = result[0];
    return {
        ...a,
        conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions,
    };
}

/**
 * Updates one or more fields of an existing alert.
 */
export async function updateAlert(
    db: Db,
    id: number,
    alertData: Partial<NewAlert>
): Promise<boolean> {
    const result = await db
        .update(alert)
        .set({
            ...alertData,
            conditions: alertData.conditions ? alertData.conditions : undefined,
        })
        .where(eq(alert.id, id))
        .execute();

    return result[0].affectedRows > 0;
}

/**
 * Updates only the status field of an alert.
 */
export async function updateAlertStatus(
    db: Db,
    id: number,
    status: 'triggered' | 'canceled'
): Promise<boolean> {
    const result = await db
        .update(alert)
        .set({ status })
        .where(eq(alert.id, id))
        .execute();

    return result[0].affectedRows > 0;
}

/**
 * Updates the `lastAlertAt` timestamp for cooldown/throttling.
 */
export async function setLastAlertTime(db: Db, id: number, timestamp: number): Promise<void> {
    await db
        .update(alert)
        .set({ lastAlertAt: timestamp })
        .where(eq(alert.id, id))
        .execute();
}

/**
 * Deletes a custom alert from the database by its ID.
 */
export async function deleteAlert(db: Db, id: number): Promise<boolean> {
    const result = await db.delete(alert).where(eq(alert.id, id)).execute();
    return result[0].affectedRows > 0;
}
