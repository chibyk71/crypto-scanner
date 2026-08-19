// src/lib/watchAlerts/types.ts
// Core types for Watch Alerts — condition trees, trade plans, evaluation results.

import type {
    AllowedIndicator,
    AllowedOperator,
    AllowedTimeframe,
} from './constants';

/**
 * Leaf condition — single indicator comparison on a specific timeframe.
 * Mirrors the shape the LLM is instructed to emit.
 */
export interface ConditionLeaf {
    kind?: 'leaf'; // optional discriminant; inferred when `indicator` is present
    indicator: AllowedIndicator | string;
    period?: number;
    timeframe: AllowedTimeframe | string;
    operator: AllowedOperator | string;
    /** Static number, indicator key (e.g. "ema_50"), or [min, max] for is_in_range */
    target: number | string | [number, number];
}

/**
 * Group condition — recursive AND / OR over child nodes.
 */
export interface ConditionGroup {
    kind?: 'group';
    op: 'AND' | 'OR';
    conditions: ConditionNode[];
}

/**
 * Discriminated condition tree node.
 * A node is a Group when it has `op` + `conditions`; otherwise it is a Leaf.
 */
export type ConditionNode = ConditionLeaf | ConditionGroup;

export function isConditionGroup(node: ConditionNode): node is ConditionGroup {
    return (
        typeof node === 'object' &&
        node !== null &&
        'op' in node &&
        Array.isArray((node as ConditionGroup).conditions)
    );
}

export function isConditionLeaf(node: ConditionNode): node is ConditionLeaf {
    return !isConditionGroup(node) && 'indicator' in node;
}

/** Declarative stop-loss specification from the pasted JSON */
export interface StopLossSpec {
    type: 'atr_multiple' | 'percent';
    value: number;
}

/** Declarative take-profit specification from the pasted JSON */
export interface TakeProfitSpec {
    type: 'percent' | 'rr';
    value: number;
}

/** Optional trailing-stop specification */
export interface TrailingSpec {
    activationPct: number;
    givebackPct: number;
}

/** Trade plan as pasted by the user / LLM */
export interface TradePlanSpec {
    direction: 'buy' | 'sell';
    stopLoss: StopLossSpec;
    takeProfit: TakeProfitSpec;
    trailing: TrailingSpec | null;
}

/**
 * Resolved trade plan — real prices computed at trigger time from
 * current price + ATR.
 */
export interface ResolvedTradePlan {
    direction: 'buy' | 'sell';
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    /** Absolute giveback distance (Bybit trailingStop style); null if no trailing */
    trailingStop: number | undefined;
    /** Price at which trailing arms; null if no trailing */
    trailingActivePrice: number | null;
    trailingStopPct: number | null;
    slDistance: number;
    tpDistance: number;
    riskReward: number;
}

/** Status values stored on watch_alerts.status */
export type WatchAlertStatus =
    | 'active'
    | 'triggered'
    | 'invalidated'
    | 'expired';

/** Reason recorded when an alert leaves active status */
export type ResolvedReason = 'entry_hit' | 'invalidated' | 'expired';

/**
 * In-memory / DB representation of a watch alert after validation & persistence.
 */
export interface WatchAlert {
    id: number;
    symbol: string;
    thesis: string;
    confidence: 'low' | 'medium' | 'high';
    status: WatchAlertStatus;
    entryConditions: ConditionNode;
    invalidateConditions: ConditionNode | null;
    tradePlan: TradePlanSpec;
    createdAt: number;
    expiresAt: number;
    resolvedAt: number | null;
    resolvedReason: ResolvedReason | null;
    triggeredPrice: number | null;
}

/** Result of evaluating a single active alert in a scan cycle */
export interface EvaluationResult {
    alert: WatchAlert;
    event: 'triggered' | 'invalidated' | 'expired';
    /** Present only when event === 'triggered' */
    resolvedPlan?: ResolvedTradePlan;
    /** Human-readable reasons from the condition tree (entry path) */
    reasons?: string[];
}

/** Per-leaf truthiness for /watchlist progress display */
export interface LeafProgress {
    description: string;
    met: boolean;
}

export interface WatchAlertProgress {
    alert: WatchAlert;
    leaves: LeafProgress[];
    metCount: number;
    totalCount: number;
}

/**
 * Structured error returned by createFromJson when validation fails.
 * Field paths use JSON-pointer-ish keys (e.g. "entry.conditions[0].indicator").
 */
export interface WatchAlertValidationError {
    ok: false;
    errors: Array<{ field: string; message: string }>;
}

export interface WatchAlertCreateSuccess {
    ok: true;
    alert: WatchAlert;
}

export type WatchAlertCreateResult =
    | WatchAlertCreateSuccess
    | WatchAlertValidationError;

/** Raw JSON shape the user pastes (pre-validation) */
export interface WatchAlertJsonInput {
    symbol: string;
    thesis: string;
    confidence: 'low' | 'medium' | 'high';
    expiryHours?: number;
    entry: ConditionNode;
    invalidate: ConditionNode | null;
    tradePlan: TradePlanSpec;
}
