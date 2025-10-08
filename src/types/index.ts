// src/types/index.ts
export type IndicatorValues = {
    rsiNow: number;
    ema50Now: number; // Not used in this snippet, but included for completeness
    ema200Now: number; // Not used in this snippet, but included for completeness
    prevClose: number;
    prevRsi: number;
    volumeNow: number; // Added to simplify volume checks
    maCross: 'bullish' | 'bearish' | 'none';
};

// src/lib/types.ts

// The base OHLCV structure used by the Strategy
export interface OhlcvData {
    symbol? : string; // Optional symbol field for reference
    timestamps: number[];
    opens: number[];
    highs: number[];
    lows: number[];
    closes: number[];
    volumes: number[];
    length: number;
}

// The core structure for a single alert condition
export interface Condition {
    // The indicator series to evaluate (e.g., 'close', 'rsi', 'ema50', 'bb_upper')
    indicator: 'close' | 'high' | 'low' | 'volume' | 'rsi' | 'ema' | 'sma' | 'macd_line' | 'macd_signal' | 'bb_upper' | 'bb_lower';
    // The specific period if needed, appended to the indicator key (e.g., 'ema_200')
    period?: number;

    // The comparison operator
    operator: 'crosses_above' | 'crosses_below' | '>' | '<' | '>=' | '<=' | 'is_equal' | 'is_not_equal' | 'is_in_range';

    // The target value to compare against.
    // - Number for static values (e.g., 70 for RSI)
    // - String for another indicator (e.g., 'ema_200')
    // - Array for 'is_in_range' operator [min, max]
    target: number | string | number[];
}

// Intermediate structure to hold the last two candles' values for evaluation
export interface EvaluatedValues {
    current: number;
    previous: number;
}
