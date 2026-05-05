// src/lib/utils/symbolRegistry.ts
// =============================================================================
// SYMBOL REGISTRY – Stable symbol → index mapping for ML feature encoding
//
// Purpose:
//   • Give the ML model a way to distinguish between symbols
//   • BTC may trend cleanly, PEPE may be noisy — the model should learn this
//   • Uses a normalized index (0–1) as a single feature in the feature vector
//
// Design decisions:
//   • Built from config.symbols at startup — stable across runs
//   • Index 0 is RESERVED for unknown/new symbols (safe fallback)
//   • Symbols are 1-indexed internally, then normalized by total count
//   • Singleton — one instance shared across the whole app
//   • No external dependencies — pure in-memory map
//
// IMPORTANT: Never reorder config.symbols between retrains.
//   Indices are positional — reordering corrupts all existing feature vectors.
//   Adding new symbols to the END is safe.
// =============================================================================

import { config } from '../config/settings';
import { createLogger } from '../logger';

const logger = createLogger('SymbolRegistry');

export class SymbolRegistry {
    /** symbol → 1-based index (0 reserved for unknown) */
    private readonly indexMap: Map<string, number>;

    /**
     * Divisor for normalization.
     * = symbols.length + 1 so that:
     *   - index 0 (unknown) → 0.0
     *   - index 1 (first)   → 1/(N+1)
     *   - index N (last)    → N/(N+1)  always < 1.0
     */
    private readonly divisor: number;

    constructor(symbols: string[]) {
        this.indexMap = new Map();

        // Build stable map from the ordered config.symbols list.
        // Order is fixed at startup — do not mutate after construction.
        symbols.forEach((symbol, i) => {
            const key = symbol.trim().toUpperCase();
            this.indexMap.set(key, i + 1); // 1-based, 0 reserved for unknown
        });

        this.divisor = symbols.length + 1;

        logger.info('SymbolRegistry initialized', {
            symbolCount: symbols.length,
            divisor: this.divisor,
            examples: symbols.slice(0, 3).map(s => {
                const key = s.trim().toUpperCase();
                const idx = this.indexMap.get(key)!;
                return `${s} → ${(idx / this.divisor).toFixed(4)}`;
            }),
        });
    }

    /**
     * Returns a normalized float in (0, 1) for a known symbol,
     * or 0.0 for unknown symbols.
     *
     * Example with 15 symbols (divisor = 16):
     *   'BTC/USDT'  (index 1)  → 1/16  = 0.0625
     *   'ETH/USDT'  (index 2)  → 2/16  = 0.1250
     *   'PEPE/USDT' (index 15) → 15/16 = 0.9375
     *   'UNKNOWN'   (index 0)  → 0/16  = 0.0000
     *
     * @param symbol Trading pair (e.g. 'BTC/USDT')
     * @returns Normalized float in [0, 1)
     */
    public getIndex(symbol: string): number {
        const key = symbol.trim().toUpperCase();
        const idx = this.indexMap.get(key) ?? 0;
        return idx / this.divisor;
    }

    /**
     * Returns true if the symbol was registered at startup.
     * Use this to warn when predicting for a symbol the model
     * has never seen during training.
     */
    public isKnown(symbol: string): boolean {
        return this.indexMap.has(symbol.trim().toUpperCase());
    }

    /** Number of registered symbols (excluding the unknown slot). */
    public size(): number {
        return this.indexMap.size;
    }

    /** All registered symbols in stable index order. */
    public toArray(): string[] {
        return Array.from(this.indexMap.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([sym]) => sym);
    }
}

// =============================================================================
// SINGLETON EXPORT
// Built once from config.symbols — index order is fixed for the app lifetime.
//
// If you add/remove/reorder symbols in config.symbols you MUST:
//   1. Delete models/model.onnx
//   2. Retrain from scratch with ml/train.py
//   3. Upload the new model.onnx to production
//
// Existing feature vectors in simulated_trades are now stale (symbol_index
// points to wrong symbols) — you may want to clear that table too.
// =============================================================================
export const symbolRegistry = new SymbolRegistry(config.symbols);
