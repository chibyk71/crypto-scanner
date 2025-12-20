// src/lib/types/signalHistory.ts
// =============================================================================
// SIGNAL HISTORY TYPES – Extends core types for simulation history & reversal detection
// Used by: signalHistoryService.ts, scanner.ts, TradeSignal enrichment
// Single source of truth for history-related data structures
// =============================================================================

import type { SignalLabel, TradeSignal } from './index'; // From core types

/**
 * Single entry in a symbol's simulation history.
 * Captures outcome of one simulated trade.
 */
export interface SimulationHistoryEntry {
    /** Unix timestamp (ms) when simulation started */
    timestamp: number;

    /** Direction of the original signal */
    direction: 'buy' | 'sell';

    /** Final outcome from simulator */
    outcome: 'partial_tp' | 'sl' | 'timeout';

    /** Realized R-multiple */
    rMultiple: number;

    /** 5-tier ML label (-2 to +2) */
    label: SignalLabel;

    /** Time from entry to close in milliseconds */
    durationMs: number;
}

/**
 * Aggregated history for one symbol.
 * Used to detect reversal bias and warn on signals.
 */
export interface SymbolHistory {
    /** Trading symbol (e.g., 'BTC/USDT') */
    symbol: string;

    /** Last N simulations (newest first, max 10) */
    lastSimulations: SimulationHistoryEntry[];

    /** Number of simulations opposite to the latest signal direction */
    reverseCount: number;

    /** Percentage of simulations with label >=1 (wins) */
    winRate: number;

    /** Average R-multiple across simulations */
    avgR: number;

    /** Direction of the most recent signal/simulation */
    lastDirection: 'buy' | 'sell' | null;

    /** Computed warning level for UI/alerts */
    warningLevel: 'safe' | 'caution' | 'high_risk';

    /** Last update timestamp (ms) */
    updatedAt: number;
}

/**
 * Warning level enum (for color-coding in Telegram/logs)
 */
export type WarningLevel = 'safe' | 'caution' | 'high_risk';

/**
 * Extension to core TradeSignal – adds optional history enrichment
 * Populated by scanner.ts after signal generation
 */
export interface TradeSignalWithHistory extends TradeSignal {
    history?: SymbolHistory;
}
