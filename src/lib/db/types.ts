// src/lib/db/types.ts
// Shared types for the database layer

import type { SimulationHistoryEntry } from '../../types/signalHistory';

/**
 * Enriched symbol history with recent aggregates for excursion analysis.
 * Used by excursion cache and strategy components.
 */
export interface EnrichedSymbolHistory {
    symbol: string;
    historyJson: SimulationHistoryEntry[];

    // Recent-only aggregates (last ~3 hours)
    recentAvgR: number;
    recentWinRate: number;
    recentReverseCount: number;
    recentMae: number;           // negative or zero
    recentMfe: number;           // positive
    recentExcursionRatio: number;
    recentSampleCount: number;

    // Recent directional
    recentMfeLong: number;
    recentMaeLong: number;
    recentWinRateLong: number;
    recentReverseCountLong: number;
    recentSampleCountLong: number;

    recentMfeShort: number;
    recentMaeShort: number;
    recentWinRateShort: number;
    recentReverseCountShort: number;
    recentSampleCountShort: number;

    updatedAt: Date;
}
