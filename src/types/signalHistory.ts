// src/lib/types/signalHistory.ts

import type { SignalLabel, SimulationOutcome, TradeSignal } from './index';

export interface SimulationHistoryEntry {
    timestamp: number;
    direction: 'buy' | 'sell';
    outcome: SimulationOutcome;
    rMultiple: number;
    label: SignalLabel;
    durationMs: number;

    /** Max Favorable Excursion (% of entry, positive) */
    mfe: number;

    /** Max Adverse Excursion (% of entry, negative or zero) */
    mae: number;

    // ── NEW: Timing metrics from 2025 scalping simulation ────────────────────────
    // These measure how quickly the best/worst price excursions were reached
    // All in milliseconds since entry
    timeToMFE_ms: number;     // Time from entry to peak favorable excursion
    timeToMAE_ms: number;     // Time from entry to peak adverse excursion (worst drawdown)
}

export interface SymbolHistory {
    symbol: string;
    lastSimulations: SimulationHistoryEntry[];

    // Lifetime
    avgR: number;
    winRate: number;
    reverseCount: number;
    avgMfe: number;
    avgMae: number;
    avgExcursionRatio: number;

    avgMfeLong: number;
    avgMaeLong: number;
    avgMfeShort: number;
    avgMaeShort: number;
    winRateLong: number;
    winRateShort: number;

    // Recent (~3h → now 2h in cache)
    recentMfe: number;
    recentMae: number;
    recentSampleCount: number;

    recentMfeLong?: number;
    recentMaeLong?: number;
    recentMfeShort?: number;
    recentMaeShort?: number;
    recentSampleCountLong?: number;
    recentSampleCountShort?: number;

    recentReverseCount: number;
    recentReverseCountLong?: number;
    recentReverseCountShort?: number;

    lastDirection: 'buy' | 'sell' | null;
    warningLevel: WarningLevel;
    updatedAt: number;
}

export type WarningLevel = 'safe' | 'caution' | 'high_risk';

export interface TradeSignalWithHistory extends TradeSignal {
    history?: SymbolHistory;
}
