/**
 * Phase 0 — Generate reproducible baseline report.
 *
 * Usage:
 *   DATABASE_URL=mysql://... npx ts-node -r dotenv/config scripts/baseline/generate-baseline-report.ts
 *   npx ts-node -r dotenv/config scripts/baseline/generate-baseline-report.ts --from-json path/to/export.json
 *   npx ts-node -r dotenv/config scripts/baseline/generate-baseline-report.ts --fixture
 *
 * Does NOT change strategy logic. Read-only against simulated_trades.
 *
 * Outputs (under reports/baseline/):
 *   BASELINE_REPORT.md
 *   BASELINE_REPORT.json
 *   BASELINE_REFERENCE.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

import { buildBaselineReport, formatBaselineMarkdown } from '../../src/lib/baseline/report';
import {
  loadBaselineRowsFromDb,
  normalizeExportRow,
} from '../../src/lib/baseline/loadFromDb';
import type { BaselineTradeRow } from '../../src/lib/baseline/types';

const REPO = 'https://github.com/chibyk71/crypto-scanner';
const OUT_DIR = path.resolve(process.cwd(), 'reports/baseline');

function gitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseArgs(): { fromJson?: string; closedOnly: boolean; fixture: boolean } {
  const args = process.argv.slice(2);
  let fromJson: string | undefined;
  let closedOnly = true;
  let fixture = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-json' && args[i + 1]) {
      fromJson = args[++i];
    }
    if (args[i] === '--include-open') {
      closedOnly = false;
    }
    if (args[i] === '--fixture') {
      fixture = true;
    }
  }
  return { fromJson, closedOnly, fixture };
}

/** Deterministic synthetic rows for offline validation (not production baseline). */
function buildFixtureRows(): BaselineTradeRow[] {
  const regimes = ['strong_trend', 'weak_trend', 'ranging', 'high_volatility', 'choppy'];
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const rows: BaselineTradeRow[] = [];
  let t = 1_700_000_000_000;
  for (let i = 0; i < 40; i++) {
    const isBuy = i % 3 !== 0;
    const isWin = i % 5 !== 0;
    const r = isWin ? 1.2 + (i % 3) * 0.3 : -0.8 - (i % 2) * 0.2;
    rows.push({
      id: i + 1,
      signalId: `fixture-${i + 1}`,
      symbol: symbols[i % symbols.length]!,
      side: isBuy ? 'buy' : 'sell',
      regime: regimes[i % regimes.length]!,
      confidence: 40 + (i % 6) * 10,
      openedAt: t,
      closedAt: t + 15 * 60_000 + (i % 4) * 10 * 60_000,
      outcome: isWin ? (i % 7 === 0 ? 'partial_tp' : 'tp') : i % 4 === 0 ? 'timeout' : 'sl',
      rMultiple: r,
      pnl: r * 10,
      label: isWin ? (r >= 2 ? 2 : 1) : r <= -1.5 ? -2 : -1,
      mfe: isWin ? 1.5 + (i % 3) * 0.4 : 0.4,
      mae: isWin ? -0.5 : -1.2,
      durationMs: 15 * 60_000 + (i % 4) * 10 * 60_000,
      timeToMFEMs: 5 * 60_000,
      timeToMAEMs: 3 * 60_000,
      wasTaken: i % 2 === 0,
      mlPredictedLabel: isWin ? 1 : -1,
      mlPredictedConfidence: 0.4 + (i % 5) * 0.1,
    });
    t += 60_000;
  }
  rows.push({
    id: 99,
    signalId: 'fixture-open',
    symbol: 'BTC/USDT',
    side: 'buy',
    regime: 'strong_trend',
    confidence: 70,
    openedAt: t,
    closedAt: null,
    outcome: null,
    rMultiple: null,
    pnl: 0,
    label: null,
    mfe: 0,
    mae: 0,
    durationMs: 0,
    timeToMFEMs: 0,
    timeToMAEMs: 0,
    wasTaken: false,
    mlPredictedLabel: null,
    mlPredictedConfidence: null,
  });
  return rows;
}

async function loadRows(opts: {
  fromJson?: string;
  closedOnly: boolean;
  fixture: boolean;
}): Promise<{ rows: BaselineTradeRow[]; source: string }> {
  if (opts.fixture) {
    const rows = buildFixtureRows();
    return {
      rows,
      source: `Deterministic fixture (${rows.length} rows) — NOT a production baseline`,
    };
  }

  if (opts.fromJson) {
    const raw = JSON.parse(fs.readFileSync(opts.fromJson, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.rows ?? raw.data ?? [];
    const rows = arr.map((r: Record<string, unknown>) => normalizeExportRow(r, 'storage'));
    return {
      rows,
      source: `JSON export file: ${opts.fromJson} (${rows.length} rows)`,
    };
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required (or pass --from-json path/to/export.json, or --fixture).\n' +
        'Example: DATABASE_URL=mysql://user:pass@host:3306/db npx ts-node ...'
    );
  }

  const pool = mysql.createPool(url);
  const db = drizzle(pool);
  try {
    const rows = await loadBaselineRowsFromDb(db, { closedOnly: opts.closedOnly });
    return {
      rows,
      source: `MySQL simulated_trades via DATABASE_URL (closedOnly=${opts.closedOnly})`,
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const generatedAt = new Date().toISOString();
  const sha = gitSha();

  console.log('Phase 0 — Baseline report generation');
  console.log(`  Commit: ${sha}`);
  console.log(`  Time:   ${generatedAt}`);

  const { rows, source } = await loadRows(opts);
  console.log(`  Source: ${source}`);
  console.log(`  Rows loaded: ${rows.length}`);

  const dataCutoff =
    rows.length > 0
      ? new Date(
          Math.max(...rows.map((r) => r.closedAt ?? r.openedAt ?? 0))
        ).toISOString()
      : null;

  const report = buildBaselineReport(rows, {
    meta: {
      repository: REPO,
      gitCommitSha: sha,
      reportGeneratedAt: generatedAt,
      dataCutoffTimestamp: dataCutoff,
      datasetDefinition:
        'All rows from simulated_trades (or export/fixture). Performance metrics use completed ' +
        'simulations only (closedAt IS NOT NULL AND outcome IS NOT NULL). ' +
        'R/MFE/MAE converted from storage units (÷1e4); PnL ÷1e8 when loading from DB.',
      queryMethodology: source,
    },
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const suffix = opts.fixture ? '.fixture' : '';
  const mdPath = path.join(OUT_DIR, `BASELINE_REPORT${suffix}.md`);
  const jsonPath = path.join(OUT_DIR, `BASELINE_REPORT${suffix}.json`);
  const refPath = path.join(OUT_DIR, `BASELINE_REFERENCE${suffix}.json`);

  fs.writeFileSync(mdPath, formatBaselineMarkdown(report), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(refPath, JSON.stringify(report.baselineReference, null, 2), 'utf8');

  console.log('');
  console.log('Wrote:');
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${refPath}`);
  console.log('');
  console.log('BASELINE REFERENCE (key regression targets):');
  console.log(JSON.stringify(report.baselineReference, null, 2));
  if (opts.fixture) {
    console.log('');
    console.log('NOTE: --fixture output is for pipeline validation only.');
    console.log('Run without --fixture against production DB to freeze live baseline.');
  } else {
    console.log('');
    console.log('Phase 0 measurement complete for this dataset.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
