// Define the condition types
export type ConditionType = 'price' | 'volume' | 'rsi' | 'trend';
export type ConditionOperator = '>' | '<' | '>=' | '<=' | 'in' | 'crosses_above' | 'crosses_below';
export type ConditionValue = number | [number, number]; // Single value or range for 'in'

export interface Condition {
    type: ConditionType;
    operator: ConditionOperator;
    value: ConditionValue;
}


export type IndicatorValues = {
    rsiNow: number;
    ema50Now: number; // Not used in this snippet, but included for completeness
    ema200Now: number; // Not used in this snippet, but included for completeness
    prevClose: number;
    prevRsi: number;
    volumeNow: number; // Added to simplify volume checks
    maCross: 'bullish' | 'bearish' | 'none';
};
