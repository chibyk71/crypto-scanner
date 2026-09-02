// src/lib/db/repositories/locks.ts
// Worker lock and heartbeat management

import { eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';

import { heartbeat, locks } from '../schema';

type Db = MySql2Database<any>;

/**
 * Checks whether another bot instance currently holds the global lock.
 */
export async function getLock(db: Db): Promise<boolean> {
    const [row] = await db
        .select({ isLocked: locks.isLocked })
        .from(locks)
        .where(eq(locks.id, 1))
        .execute();

    return row?.isLocked ?? false;
}

/**
 * Sets the global bot lock state (acquire or release).
 */
export async function setLock(db: Db, isLocked: boolean): Promise<void> {
    await db
        .insert(locks)
        .values({ id: 1, isLocked })
        .onDuplicateKeyUpdate({ set: { isLocked } })
        .execute();
}

/**
 * Retrieves the current heartbeat cycle count from the singleton heartbeat row.
 */
export async function getHeartbeatCount(db: Db): Promise<number> {
    const result = await db.select().from(heartbeat).where(eq(heartbeat.id, 1)).execute();

    if (result.length === 0) {
        await db
            .insert(heartbeat)
            .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
            .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
            .execute();
        return 0;
    }

    return result[0].cycleCount;
}

/**
 * Increments the global scan cycle counter and updates last heartbeat time.
 * Returns the new (incremented) cycle count.
 */
export async function incrementHeartbeatCount(db: Db): Promise<number> {
    const [current] = await db
        .select({ cycleCount: heartbeat.cycleCount })
        .from(heartbeat)
        .where(eq(heartbeat.id, 1))
        .execute();

    const nextCount = (current?.cycleCount ?? 0) + 1;

    await db
        .insert(heartbeat)
        .values({
            id: 1,
            cycleCount: nextCount,
            lastHeartbeatAt: Date.now(),
        })
        .onDuplicateKeyUpdate({
            set: { cycleCount: nextCount, lastHeartbeatAt: Date.now() },
        })
        .execute();

    return nextCount;
}

/**
 * Resets the heartbeat counter and timestamp to zero.
 */
export async function resetHeartbeatCount(db: Db): Promise<void> {
    await db
        .insert(heartbeat)
        .values({ id: 1, cycleCount: 0, lastHeartbeatAt: 0 })
        .onDuplicateKeyUpdate({ set: { cycleCount: 0, lastHeartbeatAt: 0 } })
        .execute();
}
