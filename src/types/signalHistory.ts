// src/lib/types/signalHistory.ts

import type { SignalLabel, TradeSignal } from './index';

export interface SimulationHistoryEntry {
    timestamp: number;
    direction: 'buy' | 'sell';
    outcome: 'partial_tp' | 'sl' | 'timeout' | 'tp';
    rMultiple: number;
    label: SignalLabel;
    durationMs: number;

    /** Max Favorable Excursion (% of entry, positive) */
    mfe: number;

    /** Max Adverse Excursion (% of entry, negative or zero) */
    mae: number;
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

    // Recent (~3h)
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
    warningLevel: 'safe' | 'caution' | 'high_risk';
    updatedAt: number;
}

export type WarningLevel = 'safe' | 'caution' | 'high_risk';

export interface TradeSignalWithHistory extends TradeSignal {
    history?: SymbolHistory;
}
