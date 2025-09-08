// src/lib/server/strategy.js
import {
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateStochastic,
    calculateATR,
    calculateBollingerBands,
    calculateOBV,
    checkMACrossover,
} from './indicators';

export interface TradeSignal {
    symbol: string;
    signal: 'buy' | 'sell' | 'hold';
    confidence: number; // 0-100
    reason: string[];
    stopLoss?: number;
    takeProfit?: number;
}

export interface MarketData {
    symbol: string;
    highs: number[];
    lows: number[];
    closes: number[];
    volumes: number[];
}

/**
 * Represents a trading strategy that generates buy/sell/hold signals based on technical indicators.
 *
 * The strategy uses a combination of trend, momentum, volatility, and volume indicators to determine trade signals.
 * It supports risk/reward targeting and exposes the latest ATR value for feasibility checks.
 *
 * ## Indicators Used:
 * - **Trend:** EMA50 vs EMA200, MA crossover (Golden/Death Cross)
 * - **Momentum:** RSI, MACD, Stochastic Oscillator
 * - **Volatility:** ATR, Bollinger Bands
 * - **Volume:** On-Balance Volume (OBV)
 *
 * ## Signal Generation Logic:
 * - **Buy:** Uptrend, momentum turning up near BB lower, volume support
 * - **Sell:** Downtrend, momentum turning down near BB upper
 * - **Hold:** No strong confluence
 *
 * ## Stop Loss & Take Profit:
 * - Stop loss is calculated using ATR and a multiplier.
 * - Take profit is set based on the risk/reward target percentage.
 *
 * @example
 * ```typescript
 * const strategy = new Strategy(3); // 3% risk/reward target
 * const signal = strategy.generateSignal(marketData);
 * ```
 *
 * @property {number} riskRewardTarget - The target return on investment (ROI) in percent for take profit calculation.
 * @property {number | null} lastAtr - The last calculated Average True Range (ATR) value, exposed for feasibility checks.
 *
 * @method generateSignal
 * Generates a trade signal based on provided market data.
 * @param {MarketData} m - The market data containing price, volume, and indicator arrays.
 * @returns {TradeSignal} The generated trade signal, including signal type, confidence, reasons, stop loss, and take profit levels.
 */
export class Strategy {
    public readonly riskRewardTarget: number; // target ROI in %
    public lastAtr: number | null = null;     // expose ATR for feasibility checks

    private rsiOverbought = 70;
    private rsiOversold = 30;
    private atrMultiplier = 1.5; // SL sizing

    constructor(riskRewardTarget = 3) {
        this.riskRewardTarget = riskRewardTarget;
    }

    /**
     * Generates a trade signal based on provided market data.
     *
     * Evaluates indicators, such as trend, momentum, volatility, and volume, to determine a trade signal.
     * The signal will be one of 'buy', 'sell', or 'hold', with a confidence level of 0-100.
     * Stop loss and take profit levels are also calculated based on the ATR and risk/reward target.
     *
     * @param {MarketData} m - The market data containing price, volume, and indicator arrays.
     * @returns {TradeSignal} The generated trade signal, including signal type, confidence, reasons, stop loss, and take profit levels.
     */
    generateSignal(m: MarketData): TradeSignal {
        const { symbol, highs, lows, closes, volumes } = m;
        const reasons: string[] = [];
        const price = closes.at(-1)!;

        // Trend
        const ema50 = calculateEMA(closes, 50);
        const ema200 = calculateEMA(closes, 200);
        const trend = ema50.at(-1)! > ema200.at(-1)! ? 'bullish' : 'bearish';
        reasons.push(trend === 'bullish' ? 'Price above EMA200 (uptrend)' : 'Price below EMA200 (downtrend)');

        const maCross = checkMACrossover(ema50, ema200);
        if (maCross === 'bullish') reasons.push('Golden Cross detected');
        else if (maCross === 'bearish') reasons.push('Death Cross detected');

        // Momentum
        const rsi = calculateRSI(closes, 14);
        const rsiNow = rsi.at(-1)!;
        if (rsiNow > this.rsiOverbought) reasons.push('RSI Overbought');
        if (rsiNow < this.rsiOversold) reasons.push('RSI Oversold');

        const macd = calculateMACD(closes);
        const macdNow = macd.at(-1)!;

        const stoch = calculateStochastic(highs, lows, closes, 14, 3);
        const stochNow = stoch.at(-1)!;

        // Volatility
        const atr = calculateATR(highs, lows, closes, 14);
        this.lastAtr = atr.at(-1)!;

        const bb = calculateBollingerBands(closes);
        const bbNow = bb.at(-1)!;
        if (price <= bbNow.lower) reasons.push('Near/Below BB lower (potential bounce)');
        if (price >= bbNow.upper) reasons.push('Near/Above BB upper (potential reversal)');

        // Volume
        const obv = calculateOBV(closes, volumes);
        if (obv.length >= 10 && obv.at(-1)! > obv.at(-10)!) reasons.push('OBV rising (volume supports move)');

        // Decision
        let signal: 'buy' | 'sell' | 'hold' = 'hold';
        let confidence = 0;

        // BUY: Uptrend + momentum turning up near BB lower + volume support
        if (
            trend === 'bullish' &&
            rsiNow < 40 &&
            macdNow.histogram > 0 &&
            stochNow.k < 20 && stochNow.d < 20 && stochNow.k > stochNow.d &&
            (price <= bbNow.lower || price <= bbNow.middle) &&
            (obv.length < 10 || obv.at(-1)! >= obv.at(-10)!)
        ) {
            signal = 'buy';
            confidence = 80;
            reasons.push('Confluence BUY: trend + momentum + BB + volume');
        }

        // SELL: Downtrend + momentum turning down near BB upper
        if (
            trend === 'bearish' &&
            rsiNow > 60 &&
            macdNow.histogram < 0 &&
            stochNow.k > 80 && stochNow.d > 80 && stochNow.k < stochNow.d &&
            (price >= bbNow.upper || price >= bbNow.middle)
        ) {
            signal = 'sell';
            confidence = 80;
            reasons.push('Confluence SELL: trend + momentum + BB');
        }

        // Levels (ATR stops, 3% TP)
        const stopLoss =
            signal === 'buy'
                ? price - this.atrMultiplier * this.lastAtr
                : signal === 'sell'
                    ? price + this.atrMultiplier * this.lastAtr
                    : undefined;

        const takeProfit =
            signal === 'buy'
                ? price * (1 + this.riskRewardTarget / 100)
                : signal === 'sell'
                    ? price * (1 - this.riskRewardTarget / 100)
                    : undefined;

        return { symbol, signal, confidence, reason: reasons, stopLoss, takeProfit };
    }
}
