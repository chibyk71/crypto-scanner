// src/lib/baseline/loadFromDb.ts
// Phase 0 — Load simulated_trades into BaselineTradeRow[].
// Converts storage precision (×1e8 pnl, ×1e4 R/MFE/MAE) to human units.
// Missing MFE/MAE remain null (never fabricated as 0).

import { desc, isNotNull } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { simulatedTrades } from '../db/schema';
import type { BaselineTradeRow } from './types';

type Db = MySql2Database<any>;

/**
 * Load all simulated trades (or closed-only) and normalize units.
 *
 * Storage conventions (from schema):
 *   - pnl: ×1e8
 *   - rMultiple, mfe, mae: ×1e4
 *   - timestamps: Unix ms
 *
 * Null MFE/MAE are preserved as null (missing ≠ 0).
 */
export async function loadBaselineRowsFromDb(
  db: Db,
  options: { closedOnly?: boolean } = {}
): Promise<BaselineTradeRow[]> {
  const closedOnly = options.closedOnly !== false;

  const query = db.select().from(simulatedTrades).orderBy(desc(simulatedTrades.openedAt));

  const rows = closedOnly
    ? await db
        .select()
        .from(simulatedTrades)
        .where(isNotNull(simulatedTrades.closedAt))
        .orderBy(desc(simulatedTrades.openedAt))
        .execute()
    : await query.execute();

  return rows.map(normalizeRow);
}

function normalizeRow(row: typeof simulatedTrades.$inferSelect): BaselineTradeRow {
  const side = row.side === 'sell' ? 'sell' : 'buy';
  return {
    id: row.id,
    signalId: row.signalId,
    symbol: row.symbol ?? '',
    side,
    regime: row.regime ?? null,
    confidence: row.confidence ?? null,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    outcome: row.outcome ?? null,
    rMultiple:
      row.rMultiple != null && Number.isFinite(row.rMultiple)
        ? row.rMultiple / 1e4
        : null,
    pnl: row.pnl != null ? row.pnl / 1e8 : 0,
    label: row.label ?? null,
    mfe:
      row.maxFavorableExcursion != null && Number.isFinite(row.maxFavorableExcursion)
        ? row.maxFavorableExcursion / 1e4
        : null,
    mae:
      row.maxAdverseExcursion != null && Number.isFinite(row.maxAdverseExcursion)
        ? row.maxAdverseExcursion / 1e4
        : null,
    durationMs: row.durationMs ?? 0,
    timeToMFEMs: row.timeToMFEMs ?? 0,
    timeToMAEMs: row.timeToMAEMs ?? 0,
    wasTaken: row.wasTaken === true,
    mlPredictedLabel: row.mlPredictedLabel ?? null,
    mlPredictedConfidence: row.mlPredictedConfidence ?? null,
  };
}

/**
 * Normalize a raw object (e.g. from CSV/JSON export) into BaselineTradeRow.
 * Accepts either storage units or already-human units via `units` flag.
 * Missing MFE/MAE remain null.
 */
export function normalizeExportRow(
  raw: Record<string, unknown>,
  units: 'storage' | 'human' = 'storage'
): BaselineTradeRow {
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string => (v == null ? '' : String(v));

  const rRaw = num(raw.rMultiple ?? raw.r_multiple);
  const pnlRaw = num(raw.pnl) ?? 0;
  const mfeRaw = num(raw.mfe ?? raw.maxFavorableExcursion ?? raw.max_favorable_excursion);
  const maeRaw = num(raw.mae ?? raw.maxAdverseExcursion ?? raw.max_adverse_excursion);

  const scaleR = units === 'storage' ? 1e4 : 1;
  const scalePnl = units === 'storage' ? 1e8 : 1;

  const sideRaw = str(raw.side).toLowerCase();
  const side: 'buy' | 'sell' = sideRaw === 'sell' ? 'sell' : 'buy';

  return {
    id: num(raw.id) ?? 0,
    signalId: str(raw.signalId ?? raw.signal_id),
    symbol: str(raw.symbol),
    side,
    regime: raw.regime != null && str(raw.regime) !== '' ? str(raw.regime) : null,
    confidence: num(raw.confidence),
    openedAt: num(raw.openedAt ?? raw.opened_at) ?? 0,
    closedAt: num(raw.closedAt ?? raw.closed_at),
    outcome: raw.outcome != null ? str(raw.outcome) : null,
    rMultiple: rRaw != null ? rRaw / scaleR : null,
    pnl: pnlRaw / scalePnl,
    label: num(raw.label),
    mfe: mfeRaw != null ? mfeRaw / scaleR : null,
    mae: maeRaw != null ? maeRaw / scaleR : null,
    durationMs: num(raw.durationMs ?? raw.duration_ms) ?? 0,
    timeToMFEMs: num(raw.timeToMFEMs ?? raw.time_to_mfe_ms) ?? 0,
    timeToMAEMs: num(raw.timeToMAEMs ?? raw.time_to_mae_ms) ?? 0,
    wasTaken: raw.wasTaken === true || raw.was_taken === true || raw.wasTaken === 1 || raw.was_taken === 1,
    mlPredictedLabel: num(raw.mlPredictedLabel ?? raw.ml_predicted_label),
    mlPredictedConfidence: num(raw.mlPredictedConfidence ?? raw.ml_predicted_confidence),
  };
}
