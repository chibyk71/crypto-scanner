// src/lib/db/repositories/trades.ts
// Live / paper trade logging

import type { MySql2Database } from 'drizzle-orm/mysql2';

import { createLogger } from '../../logger';
import { type NewTrade, trades } from '../schema';

const logger = createLogger('db:trades');

type Db = MySql2Database<any>;

/**
 * Logs a completed trade (live or paper) to the database.
 *
 * Called from:
 *   • MarketScanner (paper trades via simulation)
 *   • AutoTradeService (real live trades)
 */
export async function logTrade(db: Db, tradeData: NewTrade): Promise<number> {
    const [inserted] = await db.insert(trades).values(tradeData).execute();
    logger.debug(`Logged trade for ${tradeData.symbol}`, { id: inserted.insertId });
    return inserted.insertId;
}
