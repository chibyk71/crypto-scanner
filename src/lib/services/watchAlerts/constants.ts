// src/lib/watchAlerts/constants.ts
// Named constants for the Watch Alerts feature — no magic numbers inline.

/** Default alert lifetime when the pasted JSON omits expiryHours */
export const DEFAULT_EXPIRY_HOURS = 24;

/** Minimum allowed expiry (hours) — clamped at paste-in time */
export const MIN_EXPIRY_HOURS = 1;

/** Maximum allowed expiry (hours) — clamped at paste-in time */
export const MAX_EXPIRY_HOURS = 72;

/** Hard cap on simultaneously active watch alerts */
export const MAX_CONCURRENT_ACTIVE_ALERTS = 5;

/** Per-symbol cooldown for trending notifications (12 hours) */
export const TRENDING_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Maximum nesting depth for ConditionNode groups (root = depth 1) */
export const MAX_CONDITION_TREE_DEPTH = 4;

/** Indicators accepted in leaf conditions — must map to computeIndicators() series */
export const ALLOWED_INDICATORS = [
    'rsi',
    'ema',
    'sma',
    'macd_line',
    'macd_signal',
    'macd_histogram',
    'atr',
    'adx',
    'obv',
    'vwma',
    'vwap',
    'momentum',
    'stoch_k',
    'stoch_d',
    'bb_upper',
    'bb_middle',
    'bb_lower',
    'percent_b',
    'close',
    'high',
    'low',
    'volume',
] as const;

export type AllowedIndicator = (typeof ALLOWED_INDICATORS)[number];

/** Timeframes a leaf may reference */
export const ALLOWED_TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h'] as const;

export type AllowedTimeframe = (typeof ALLOWED_TIMEFRAMES)[number];

/** Comparison operators supported by the evaluator */
export const ALLOWED_OPERATORS = [
    'crosses_above',
    'crosses_below',
    '>',
    '<',
    '>=',
    '<=',
    'is_in_range',
] as const;

export type AllowedOperator = (typeof ALLOWED_OPERATORS)[number];

/** Absolute SL distance cap as fraction of price (matches riskParams 10% gate) */
export const MAX_SL_DISTANCE_PCT = 0.10;

/** Minimum acceptable risk:reward at paste-in validation */
export const MIN_RR = 1;
