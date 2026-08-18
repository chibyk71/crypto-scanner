// src/lib/db/repositories/cooldown.ts
// Symbol cooldown management

import { eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { coolDownTable } from '../schema';
import { createLogger } from '../../logger';

const logger = createLogger('db:cooldown');

type Db = MySql2Database<any>;

/**
 * Retrieves the cooldown record for a specific symbol.
 */
export async function getCoolDown(db: Db, symbol: string): Promise<{
    id: number;
    symbol: string | null;
    lastTradeAt: number;
}> {
    const rows = await db.select().from(coolDownTable).where(eq(coolDownTable.symbol, symbol)).execute();
    return rows[0];
}

/**
 * Upserts (insert or update) a cooldown entry for a given symbol.
 * Fail-open: logs errors but does not throw.
 */
export async function upsertCoolDown(
    db: Db,
    symbol: string,
    lastTradeAt: number = Date.now()
): Promise<void> {
    try {
        if (!Number.isFinite(lastTradeAt) || lastTradeAt <= 0) {
            logger.warn('Invalid lastTradeAt provided to upsertCoolDown – using current time', {
                symbol,
                received: lastTradeAt,
                fallback: Date.now(),
            });
            lastTradeAt = Date.now();
        }

        await db
            .insert(coolDownTable)
            .values({
                symbol,
                lastTradeAt,
            })
            .onDuplicateKeyUpdate({
                set: {
                    lastTradeAt,
                },
            })
            .execute();

        logger.debug('Cooldown upserted successfully', {
            symbol,
            lastTradeAt: new Date(lastTradeAt).toISOString(),
        });
    } catch (err) {
        logger.error('Failed to upsert cooldown entry', {
            symbol,
            lastTradeAt: new Date(lastTradeAt).toISOString(),
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        });
    }
}
