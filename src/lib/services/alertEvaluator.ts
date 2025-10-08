// src/lib/analysis/alertEvaluator.ts

import { OhlcvData, Condition, EvaluatedValues } from '../../types';
import {
    calculateRSI,
    calculateEMA,
    calculateSMA,
    calculateBollingerBands,
    calculateMACD,
    // Add other necessary indicators here
} from '../indicators'; // Assuming this imports from your existing indicators.ts

export class AlertEvaluatorService {

    /**
     * Dynamically calculates the required indicator series for the given timeframe data.
     * This acts as an internal cache to avoid re-calculating the same series multiple times.
     * @param data - The OHLCV data for the alert's timeframe.
     * @returns A map of indicator keys (e.g., 'rsi_14') to their full series array.
     */
    private calculateAllSeries(data: OhlcvData): Map<string, number[] | { upper: number, middle: number, lower: number }[]> {
        const seriesMap = new Map<string, number[] | any[]>();

        // 1. Price Series
        seriesMap.set('close', data.closes);
        seriesMap.set('high', data.highs);
        seriesMap.set('low', data.lows);
        seriesMap.set('volume', data.volumes);

        // 2. Standard Indicators
        // Always calculate standard periods used by the Strategy/common alerts
        seriesMap.set('rsi_14', calculateRSI(data.closes, 14));
        seriesMap.set('ema_50', calculateEMA(data.closes, 50));
        seriesMap.set('ema_200', calculateEMA(data.closes, 200));
        seriesMap.set('sma_20', calculateSMA(data.closes, 20));

        // 3. Complex Indicators (MACD, BB)
        const macdResult = calculateMACD(data.closes);
        if (macdResult.length) {
            seriesMap.set('macd_line', macdResult.map(m => m.MACD));
            seriesMap.set('macd_signal', macdResult.map(m => m.signal));
        }

        const bbResult = calculateBollingerBands(data.closes);
        if (bbResult.length) {
            seriesMap.set('bb_upper', bbResult.map(b => b.upper));
            seriesMap.set('bb_lower', bbResult.map(b => b.lower));
        }

        return seriesMap;
    }

    /**
     * Retrieves the current and previous value for a specified indicator key.
     * @param seriesMap - Map of all calculated indicator series.
     * @param key - The indicator key (e.g., 'rsi_14', 'close').
     * @returns The current and previous values, or undefined if data is insufficient.
     */
    private getValues(seriesMap: Map<string, number[] | any[]>, key: string): EvaluatedValues | undefined {
        const series = seriesMap.get(key);

        if (!series || series.length < 2) {
            return undefined;
        }

        // Use the last two elements of the series for current and previous values
        return {
            current: series.at(-1) as number,
            previous: series.at(-2) as number,
        };
    }

    /**
     * The core logic to evaluate the conditions of a single alert against the market data.
     * @param data - The OHLCV data for the alert's timeframe.
     * @param conditions - The array of alert conditions from the database.
     * @returns An object indicating if all conditions were met and an array of success reasons.
     */
    public evaluate(data: OhlcvData, conditions: Condition[]): { conditionsMet: boolean, reasons: string[] } {
        const seriesMap = this.calculateAllSeries(data);
        const reasons: string[] = [];

        for (const cond of conditions) {
            // 1. Identify the primary series to evaluate (e.g., close, rsi, ema_50)
            const indicatorKey = cond.period ? `${cond.indicator}_${cond.period}` : cond.indicator;
            const primaryValues = this.getValues(seriesMap, indicatorKey);

            if (!primaryValues) {
                // If indicator data is missing, we conservatively fail the condition.
                return { conditionsMet: false, reasons: [] };
            }

            // 2. Determine the Target Value
            let targetValue: number;

            if (typeof cond.target === 'string') {
                // Target is another indicator (e.g., 'close' crosses 'ema_200')
                const targetValues = this.getValues(seriesMap, cond.target);
                if (!targetValues) return { conditionsMet: false, reasons: [] };
                targetValue = targetValues.current; // Target is always the current target indicator value
            } else if (Array.isArray(cond.target)) {
                // Target is a range [min, max], handled later
                targetValue = 0; // Placeholder
            } else {
                // Target is a static number
                targetValue = cond.target;
            }

            let conditionPassed = false;
            let reasonText = `${indicatorKey.toUpperCase()} (${primaryValues.current.toFixed(4)})`;

            // 3. Evaluate the Operator
            switch (cond.operator) {
                case 'crosses_above':
                case 'crosses_below':
                    // These require previous and current values for both the primary and target series
                    const prevTarget = typeof cond.target === 'string' ? this.getValues(seriesMap, cond.target)?.previous : targetValue;

                    if (prevTarget === undefined) {
                        break; // Fail if previous target value is missing
                    }

                    if (cond.operator === 'crosses_above') {
                        conditionPassed = primaryValues.previous <= prevTarget && primaryValues.current > targetValue;
                        reasonText += ` crosses above ${cond.target}`;
                    } else { // crosses_below
                        conditionPassed = primaryValues.previous >= prevTarget && primaryValues.current < targetValue;
                        reasonText += ` crosses below ${cond.target}`;
                    }
                    break;

                case '>':
                    conditionPassed = primaryValues.current > targetValue;
                    reasonText += ` is > ${targetValue.toFixed(4)}`;
                    break;
                case '<':
                    conditionPassed = primaryValues.current < targetValue;
                    reasonText += ` is < ${targetValue.toFixed(4)}`;
                    break;
                case '>=':
                    conditionPassed = primaryValues.current >= targetValue;
                    reasonText += ` is >= ${targetValue.toFixed(4)}`;
                    break;
                case '<=':
                    conditionPassed = primaryValues.current <= targetValue;
                    reasonText += ` is <= ${targetValue.toFixed(4)}`;
                    break;
                case 'is_equal':
                    conditionPassed = primaryValues.current === targetValue;
                    reasonText += ` is exactly equal to ${targetValue.toFixed(4)}`;
                    break;

                case 'is_in_range':
                    if (Array.isArray(cond.target) && cond.target.length === 2) {
                        const [min, max] = cond.target as [number, number];
                        conditionPassed = primaryValues.current >= min && primaryValues.current <= max;
                        reasonText += ` is in range [${min.toFixed(4)}, ${max.toFixed(4)}]`;
                    }
                    break;

                // Add support for operators like 'is_not_equal', etc. here
            }

            if (!conditionPassed) {
                return { conditionsMet: false, reasons: [] }; // Fail fast if any condition fails
            }

            reasons.push(reasonText);
        }

        return { conditionsMet: true, reasons };
    }
}
