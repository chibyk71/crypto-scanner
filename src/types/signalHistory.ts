// src/lib/types/signalHistory.ts

import type { SignalLabel, SimulationOutcome, TradeSignal } from './index';

/**
 * Single completed simulation entry — raw per-trade data
 * Already purely directional (has 'direction' field) — no changes needed
 */
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

    /** Time from entry to peak favorable excursion (ms) */
    timeToMFE_ms: number;

    /** Time from entry to peak adverse excursion (ms) */
    timeToMAE_ms: number;
}

/**
 * Aggregated directional statistics for one symbol
 *
 * 2026+ PURE DIRECTIONAL DESIGN:
 *   - All statistics (MFE/MAE/ratio/win rate/duration/reversals/outcomes)
 *     exist ONLY inside buy/sell nested objects
 *   - NO combined aggregates except recentSampleCount (used exclusively
 *     for the "total ≥ 3 → send alert" gate in AutoTradeService)
 *   - If a side is missing or has sampleCount < 3 → decision MUST be 'skip'
 *   - No fallback to combined stats allowed anywhere in scoring/advice
 */
export interface SymbolHistory {
    symbol: string;

    /** Raw recent simulations (newest first) — source for filtering by direction */
    lastSimulations: SimulationHistoryEntry[];

    // ── ONLY combined field allowed — used SOLELY for alert gate ───────────────
    /** Total recent completed simulations (buy + sell) – ONLY for deciding whether to send alert */
    recentSampleCount: number;

    // ── Pure directional statistics – the ONLY source for decisions ─────────────
    /** Buy / Long side statistics */
    buy?: {
        sampleCount: number;
        mfe: number;
        mae: number;
        excursionRatio: number;
        avgDurationMs: number;
        winRate: number;
        reverseCount: number;
        outcomeCounts: {
            tp: number;
            partial_tp: number;
            sl: number;
            timeout: number;
        };
        /** Optional: consecutive SL streak for buy side only */
        slStreak?: number;
    };

    /** Sell / Short side statistics */
    sell?: {
        sampleCount: number;
        mfe: number;
        mae: number;
        excursionRatio: number;
        avgDurationMs: number;
        winRate: number;
        reverseCount: number;
        outcomeCounts: {
            tp: number;
            partial_tp: number;
            sl: number;
            timeout: number;
        };
        /** Optional: consecutive SL streak for sell side only */
        slStreak?: number;
    };

    /** Last trade direction (for quick context / UI) */
    lastDirection: 'buy' | 'sell' | null;

    /** Warning level (derived from directional data) */
    warningLevel: WarningLevel;

    /** Last update timestamp */
    updatedAt: number;
}

/**
 * Simplified warning levels (can be computed from directional aggregates)
 */
export type WarningLevel = 'safe' | 'caution' | 'high_risk';

/**
 * Trade signal enriched with pure-directional history
 * (used when passing signal + regime to AutoTrade or alerts)
 */
export interface TradeSignalWithHistory extends TradeSignal {
    history?: SymbolHistory;
}
