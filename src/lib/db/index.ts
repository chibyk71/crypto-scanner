import { drizzle } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { alert, locks, type Alert, type NewAlert } from './schema';
import { config } from '../config/settings';

if (!config.database_url) throw new Error('database_url is not set');

let client: Client | null = createClient({ url: config.database_url });

export const db = drizzle(client, { schema: { alert, locks } });

async function initializeClient() {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            client = createClient({ url: config.database_url });
            await client.execute('SELECT 1');
            return;
        } catch (err) {
            console.error(`Database connection attempt ${i + 1} failed:`, err);
            if (i === maxRetries - 1) throw new Error('Failed to connect to database');
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

export async function closeDb() {
    if (client) {
        client.close();
        client = null;
    }
}

initializeClient().catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});

export const dbService = {
    async createAlert(alertData: NewAlert): Promise<Alert> {
        const [inserted] = await db.insert(alert).values(alertData).returning();
        return inserted;
    },

    async getActiveAlerts(): Promise<Alert[]> {
        return db.select().from(alert).where(eq(alert.status, 'active')).execute();
    },

    async getAlertsBySymbol(symbol: string): Promise<Alert[]> {
        return db
            .select()
            .from(alert)
            .where(and(eq(alert.symbol, symbol), eq(alert.status, 'active')))
            .execute();
    },

    async updateAlertStatus(id: number, status: 'triggered' | 'canceled'): Promise<Alert> {
        const [updated] = await db
            .update(alert)
            .set({ status })
            .where(eq(alert.id, id))
            .returning();
        if (!updated) throw new Error(`Alert with id ${id} not found`);
        return updated;
    },

    async deleteAlert(id: number): Promise<void> {
        await db.delete(alert).where(eq(alert.id, id)).execute();
    },

    async getLastAlertTimes(): Promise<Record<string, number>> {
        const result = await db
            .select({ symbol: alert.symbol, lastAlertAt: alert.lastAlertAt })
            .from(alert)
            .where(eq(alert.status, 'active'))
            .execute();
        return result.reduce((acc, { symbol, lastAlertAt }) => {
            acc[symbol] = Math.max(acc[symbol] || 0, lastAlertAt || 0);
            return acc;
        }, {} as Record<string, number>);
    },

    async setLastAlertTime(id: number, timestamp: number): Promise<void> {
        await db
            .update(alert)
            .set({ lastAlertAt: timestamp })
            .where(eq(alert.id, id))
            .execute();
    },

    async getLock(): Promise<boolean> {
        const result = await db.select().from(locks).where(eq(locks.id, 1)).execute();
        return result.length > 0 ? result[0].isLocked! : false;
    },

    async setLock(isLocked: boolean): Promise<void> {
        await db
            .insert(locks)
            .values({ id: 1, isLocked })
            .onConflictDoUpdate({ target: locks.id, set: { isLocked } })
            .execute();
    }
};
