// src/types/index.ts
// =============================================================================
// CORE TYPE DEFINITIONS – SINGLE SOURCE OF TRUTH FOR THE ENTIRE TRADING BOT
// This file is imported by EVERY module: strategy, scanner, ML, DB, simulateTrade, etc.
// Any change here cascades – keep it clean, stable, and heavily documented.
// =============================================================================

/**
 * OHLCV data structure – represents historical candle data for a symbol
 * All arrays must be exactly the same length. Used by:
 *   • ExchangeService (raw CCXT → formatted)
 *   • Strategy (primary + HTF input)
 *   • MarketScanner (caching)
 *   • AlertEvaluator (condition checking)
 */
export interface OhlcvData {
    /** Optional symbol identifier – useful for debugging and logging */
    symbol?: string;

    /** Unix timestamps in milliseconds (aligned with candle close time) */
    timestamps: number[];

    /** Opening prices for each candle */
    opens: number[];

    /** Highest price reached during each candle */
    highs: number[];

    /** Lowest price reached during each candle */
    lows: number[];

    /** Closing prices – most commonly used for indicators */
    closes: number[];

    /** Trading volume in base asset (e.g., BTC volume for BTC/USDT) */
    volumes: number[];

    /** Convenience: total number of candles in this dataset */
    length: number;
}

/**
 * Single condition used in custom user-defined alerts
 * Stored as JSON in DB → evaluated by AlertEvaluatorService
 *
 * Examples:
 *   { indicator: 'rsi', period: 14, operator: '<', target: 30 }
 *   { indicator: 'close', operator: 'crosses_above', target: 'ema_200' }
 *   { indicator: 'rsi', period: 14, operator: 'is_in_range', target: [30, 70] }
 */
export interface Condition {
    /** Base indicator name – must match keys in AlertEvaluator series map */
    indicator:
        | 'close'
        | 'high'
        | 'low'
        | 'open'
        | 'volume'
        | 'rsi'
        | 'ema'
        | 'sma'
        | 'macd_line'
        | 'macd_signal'
        | 'macd_histogram'
        | 'bb_upper'
        | 'bb_middle'
        | 'bb_lower'
        | 'atr'
        | 'obv'
        | 'vwma'
        | 'vwap'
        | 'momentum'
        | 'adx'
        | 'engulfing';

    /** Optional period – becomes part of the key (e.g., 'rsi_14', 'ema_50') */
    period?: number;

    /** Comparison operator – determines how target is evaluated */
    operator:
        | 'crosses_above'
        | 'crosses_below'
        | '>'
        | '<'
        | '>='
        | '<='
        | 'is_equal'
        | 'is_not_equal'
        | 'is_in_range';

    /**
     * Target value to compare against:
     *   • number → static value (e.g., 70)
     *   • string → another indicator key (e.g., 'ema_200')
     *   • [number, number] → range for 'is_in_range'
     */
    target: number | string | number[];
}

/**
 * Helper type used internally by AlertEvaluator
 * Holds current and previous value of an indicator for crossover detection
 */
export interface EvaluatedValues {
    current: number;
    previous: number;
}

/**
 * Partial take-profit level – enables scaling out of winning trades
 * Used in high-precision simulation and (eventually) live execution
 */
export interface PartialTPLevel {
    /** Price at which to close this portion */
    price: number;

    /** Fraction of total position to close (0.0 → 1.0). Must sum ≤ 1.0 across all levels */
    weight: number;
}

/**
 * Final output from Strategy.generateSignal()
 * This is the "decision" object passed to scanner → simulator → ML → execution
 *
 * Now supports:
 *   • 5-tier labeling (-2 to +2) from simulation
 *   • Partial take-profits
 *   • Trailing stops
 *   • MFE/MAE tracking
 *   • Feature vector for immediate ML ingestion
 */
export interface TradeSignal {
    /** Trading pair (e.g., 'BTC/USDT') */
    symbol: string;

    /** Final trading decision */
    signal: 'buy' | 'sell' | 'hold';

    /** Overall confidence score (0–100) – combination of technical + ML */
    confidence: number;

    /** Human-readable reasons why this signal was generated */
    reason: string[];

    /** Fixed stop-loss price (ATR-based) */
    stopLoss?: number;

    /** Legacy: single take-profit (used if no partial levels) */
    takeProfit?: number;

    /** Advanced: multiple partial take-profit levels (recommended) */
    takeProfitLevels?: PartialTPLevel[];

    /** Distance in price units for trailing stop (if enabled) */
    trailingStopDistance?: number;

    /** Scale position size based on confidence/risk (0.1 → 1.0) */
    positionSizeMultiplier?: number;

    /** Raw probability from ML model (0–1) – only present if model trained */
    mlConfidence?: number;

    /** Feature vector used for this prediction – critical for training */
    features: number[];

    // === FIELDS POPULATED AFTER SIMULATION (optional but essential for ML) ===
    /** 5-tier outcome label from simulateTrade (-2 = disaster, +2 = monster win) */
    label?: -2 | -1 | 0 | 1 | 2;

    /** Realized R-multiple (e.g., 2.7 = made 2.7× risk) */
    rMultiple?: number;

    /** Max Favorable Excursion – best unrealized profit in favorable direction */
    mfe?: number;

    /** Max Adverse Excursion – worst unrealized drawdown */
    mae?: number;
}

/**
 * Input object passed to Strategy.generateSignal()
 * Contains everything the strategy needs to make a decision
 */
export interface StrategyInput {
    /** Symbol being analyzed */
    symbol: string;

    /** Primary timeframe data (e.g., 3-minute candles) – fast signals */
    primaryData: OhlcvData;

    /** Higher timeframe data (e.g., 1-hour) – trend filter */
    htfData: OhlcvData;

    /** Current market price (best bid/ask or last trade) */
    price: number;

    /** How many ATRs away to place stop-loss */
    atrMultiplier: number;

    /** Desired risk:reward ratio (e.g., 3 → aim for 3R wins) */
    riskRewardTarget: number;

    /** Trailing stop as percentage of price move (converted to distance internally) */
    trailingStopPercent: number;
}

/**
 * 5-tier ML label type – the heart of our edge
 * Based on realized R-multiple from high-fidelity simulation
 */
export type SignalLabel = -2 | -1 | 0 | 1 | 2;

/**
 * Simulation outcome types
 */
export type SimulationOutcome =
    | 'tp'           // Hit full take-profit
    | 'partial_tp'   // Hit one or more partial TPs
    | 'sl'           // Stop-loss triggered
    | 'timeout'      // Position closed after max hold time
    | 'trailing_sl'; // Trailing stop triggered
