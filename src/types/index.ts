// Define the condition types
export type ConditionType = 'price' | 'volume' | 'rsi' | 'trend';
export type ConditionOperator = '>' | '<' | '>=' | '<=' | 'in' | 'crosses_above' | 'crosses_below';
export type ConditionValue = number | [number, number]; // Single value or range for 'in'

export interface Condition {
    type: ConditionType;
    operator: ConditionOperator;
    value: ConditionValue;
}
