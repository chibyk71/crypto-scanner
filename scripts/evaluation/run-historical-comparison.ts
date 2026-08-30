/**
 * Historical comparison harness CLI.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/evaluation/run-historical-comparison.ts --fixture
 *   npx ts-node -r dotenv/config scripts/evaluation/run-historical-comparison.ts --from-json path/to/candles.json
 *
 * Does NOT optimize strategy parameters.
 * Does NOT use simulated_trades.csv for tuning.
 * Production default remains legacy.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  runHistoricalComparison,
  type HistoricalCandle,
} from '../../src/lib/evaluation';

function fixtureCandles(n = 120): HistoricalCandle[] {
  const out: HistoricalCandle[] = [];
  let price = 50000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 40 + (i % 11 === 0 ? 80 : 0);
    const open = price;
    const close = price + drift * 0.1;
    const high = Math.max(open, close) + 15;
    const low = Math.min(open, close) - 15;
    out.push({
      symbol: 'BTC/USDT',
      timeframe: '3m',
      timestamp: 1_700_000_000_000 + i * 180_000,
      open,
      high,
      low,
      close,
      volume: 100 + (i % 20),
    });
    price = close;
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let candles: HistoricalCandle[];
  let label = 'cli-run';

  if (args.includes('--fixture')) {
    candles = fixtureCandles(150);
    label = 'synthetic-fixture';
  } else if (args.includes('--from-json')) {
    const idx = args.indexOf('--from-json');
    const file = args[idx + 1];
    if (!file) throw new Error('--from-json requires a path');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    candles = Array.isArray(raw) ? raw : raw.candles;
    label = path.basename(file);
  } else {
    console.log(
      'Usage: --fixture | --from-json <path>\n' +
        'Provide unseen historical OHLCV as JSON array of HistoricalCandle.'
    );
    process.exit(1);
  }

  const result = await runHistoricalComparison({
    candles,
    manifestLabel: label,
    assumptions: {
      minPrimaryBars: Math.min(50, Math.floor(candles.length / 3)),
      minHtfBars: 10,
      maxHoldBars: 10,
    },
  });

  console.log(JSON.stringify({
    disclaimer: result.disclaimer,
    manifest: result.manifest,
    assumptions: result.assumptions,
    legacy: {
      decisionsAttempted: result.legacy.decisionsAttempted,
      holdCount: result.legacy.holdCount,
      tradeCount: result.legacy.trades.length,
      metrics: result.legacy.metrics,
    },
    regime: {
      decisionsAttempted: result.regime.decisionsAttempted,
      holdCount: result.regime.holdCount,
      tradeCount: result.regime.trades.length,
      metrics: result.regime.metrics,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
