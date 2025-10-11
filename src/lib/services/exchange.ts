/**
 * ExchangeService handles interactions with a cryptocurrency exchange via CCXT.
 * Fetches and caches OHLCV data for multiple timeframes, supports polling for real-time updates,
 * and provides access to supported symbols and latest prices.
 */

import { config } from '../config/settings';
import ccxt, { type OHLCV, Exchange } from 'ccxt';
import { createLogger } from '../logger';
import type { OhlcvData } from '../../types';

// Initialize logger with 'ExchangeService' label for structured logging
const logger = createLogger('ExchangeService');

export class ExchangeService {
    // Private instance of the CCXT exchange client
    private exchange: Exchange;
    // Store OHLCV data for the primary timeframe (config.scanner.primaryTimeframe)
    private primaryOhlcvData: { [symbol: string]: OHLCV[] } = {};
    // Store data fetched for non-primary timeframes to serve for the current scan cycle
    // Structure: { symbol: { timeframe: OHLCV[] } }
    private ohlcvCache: { [symbol: string]: { [timeframe: string]: OHLCV[] } } = {};
    // Track polling intervals for each symbol (only for primary timeframe)
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};
    // Store supported symbols as an Array
    private supportedSymbols: string[] = [];
    // Maximum candles to fetch per request to the exchange (CCXT limit)
    private readonly MAX_EXCHANGE_LIMIT = 1000;

    /**
     * Constructor for ExchangeService. Initializes the CCXT exchange instance
     * with the configured exchange name and settings (e.g., rate limiting).
     */
    constructor() {
        logger.info('Initializing ExchangeService...', { exchange: config.exchange.name });
        this.exchange = this.createExchange(config.exchange.name);
    }

    // --- Private Helper Methods ---

    /**
     * Creates and configures a CCXT exchange instance.
     * @param id - The exchange identifier (e.g., 'binance').
     * @returns Configured CCXT exchange instance.
     */
    private createExchange(id: string): Exchange {
        const exchangeClass = (ccxt as any)[id];
        if (!exchangeClass) {
            logger.error(`Exchange ${id} is not supported`);
            throw new Error(`Exchange ${id} is not supported`);
        }
        return new exchangeClass({
            enableRateLimit: true, timeout: 60000, option: {
                defaultType: 'future'
            }
        }) as Exchange;
    }

    /**
     * Loads supported symbols from the exchange, filtered by the config.symbols whitelist.
     */
    private async loadSupportedSymbols(): Promise<void> {
        try {
            logger.info('Loading all markets from the exchange...');
            const markets = await this.exchange.loadMarkets();
            this.supportedSymbols = Object.keys(markets).filter(symbol =>
                config.symbols.includes(symbol)
            );
            if (this.supportedSymbols.length === 0) {
                logger.warn('No supported symbols found based on config.symbols');
            }
            logger.info(`Successfully loaded ${this.supportedSymbols.length} whitelisted markets`);
        } catch (error) {
            logger.error('Failed to load markets from the exchange', { error });
            throw error;
        }
    }

    /**
     * Starts polling for real-time OHLCV data updates for the given symbol.
     * Polling only occurs for the primary timeframe.
     * @param symbol - The symbol to poll (e.g., 'BTC/USDT').
     */
    private startPolling(symbol: string): void {
        const maxRetries = 3;
        let retryCount = 0;
        const timeframe = config.scanner.primaryTimeframe;

        if (!this.supportedSymbols.includes(symbol)) {
            logger.warn(`Symbol ${symbol} not supported, skipping polling`);
            return;
        }

        if (this.pollingIntervals[symbol]) {
            logger.debug(`Polling already active for ${symbol}`);
            return;
        }

        const interval = setInterval(async () => {
            try {
                const newData = await this.exchange.fetchOHLCV(
                    symbol,
                    timeframe,
                    undefined,
                    config.historyLength
                );
                this.primaryOhlcvData[symbol] = newData;
                logger.info(`[${symbol}:${timeframe}] Updated OHLCV`, {
                    latestClose: newData[newData.length - 1]?.[4] ?? 'N/A'
                });
                retryCount = 0;
            } catch (error) {
                retryCount++;
                logger.error(`[${symbol}:${timeframe}] Error fetching OHLCV (attempt ${retryCount}/${maxRetries})`, {
                    error: (error as Error).message
                });
                if (retryCount >= maxRetries) {
                    logger.error(`[${symbol}:${timeframe}] Max retries reached, stopping polling`);
                    this.stopPolling(symbol);
                }
            }
        }, config.scanner.scanIntervalMs);

        this.pollingIntervals[symbol] = interval;
        logger.info(`Started polling for ${symbol} on ${timeframe}`);
    }

    /**
     * Stops polling for the specified symbol by clearing its interval.
     * @param symbol - The symbol to stop polling for.
     */
    private stopPolling(symbol: string): void {
        if (this.pollingIntervals[symbol]) {
            clearInterval(this.pollingIntervals[symbol]);
            delete this.pollingIntervals[symbol];
            logger.info(`[${symbol}] Polling stopped`);
        }
    }

    // --- Public Interface Methods ---

    /**
     * Returns the list of supported symbols.
     * @returns Array of supported symbol strings.
     */
    public getSupportedSymbols(): string[] {
        return this.supportedSymbols;
    }

    /**
     * Initializes the ExchangeService by fetching initial OHLCV data for the primary timeframe
     * and starting polling for real-time updates.
     */
    async initialize(): Promise<void> {
        await this.loadSupportedSymbols();

        const promises = this.supportedSymbols.map(async (symbol) => {
            try {
                this.primaryOhlcvData[symbol] = await this.exchange.fetchOHLCV(
                    symbol,
                    config.scanner.primaryTimeframe,
                    undefined,
                    config.historyLength
                );
                logger.info(`Fetched initial OHLCV for ${symbol} (${config.scanner.primaryTimeframe})`, {
                    candles: this.primaryOhlcvData[symbol].length
                });
                this.startPolling(symbol);
            } catch (error) {
                logger.error(`Error fetching initial OHLCV for ${symbol} (${config.scanner.primaryTimeframe})`, { error });
            }
        });

        await Promise.all(promises);
        logger.info('ExchangeService initialization complete.');
    }

    /**
     * Stops all polling intervals for all symbols, used during shutdown.
     */
    stopAll(): void {
        Object.keys(this.pollingIntervals).forEach(symbol => this.stopPolling(symbol));
        logger.info('All polling stopped');
    }

    /**
     * Retrieves OHLCV data for a given symbol and timeframe.
     * Uses cached data for primary timeframe and fetches/caches secondary timeframes.
     * @param symbol - The symbol (e.g., 'BTC/USDT').
     * @param timeframe - The requested timeframe (e.g., '1h'). Defaults to primaryTimeframe.
     * @returns Array of OHLCV data.
     */
    async getOHLCV(symbol: string, timeframe?: string): Promise<OhlcvData> {
        const targetTimeframe = timeframe || config.scanner.primaryTimeframe;
        const defaultHistory = config.historyLength ?? 200;

        if (!this.supportedSymbols.includes(symbol)) {
            logger.warn(`Symbol ${symbol} not supported`);
            return { timestamps: [], opens: [], highs: [], lows: [], closes: [], volumes: [], length: 0 };
        }

        if (targetTimeframe === config.scanner.primaryTimeframe) {
            return this.toOhlcvData(this.primaryOhlcvData[symbol]) || { timestamps: [], opens: [], highs: [], lows: [], closes: [], volumes: [], length: 0 };
        }

        if (this.ohlcvCache[symbol]?.[targetTimeframe]) {
            logger.debug(`Using cached OHLCV for ${symbol}:${targetTimeframe}`);
            return this.toOhlcvData(this.ohlcvCache[symbol][targetTimeframe]);
        }

        try {
            const data = await this.withRetries(() =>
                this.exchange.fetchOHLCV(
                    symbol,
                    targetTimeframe,
                    undefined,
                    defaultHistory
                ),
                3
            );
            this.ohlcvCache[symbol] = this.ohlcvCache[symbol] || {};
            this.ohlcvCache[symbol][targetTimeframe] = data;
            logger.info(`Fetched OHLCV for ${symbol}:${targetTimeframe}`, { candles: data.length });
            return this.toOhlcvData(data);
        } catch (error) {
            logger.error(`Error fetching OHLCV for ${symbol}:${targetTimeframe}`, { error });
            return { timestamps: [], opens: [], highs: [], lows: [], closes: [], volumes: [], length: 0 };
        }
    }

    /**
 * Fetches a specific limit of historical OHLCV data using pagination.
 * @param symbol - The symbol (e.g., 'BTC/USDT').
 * @param timeframe - The timeframe (e.g., '3m').
 * @param desiredLimit - The total number of historical candles to fetch.
 * @returns {Promise<OhlcvData>} The historical OHLCV data.
 */
    public async fetchHistoricalOHLCV(symbol: string, timeframe: string, desiredLimit: number): Promise<OhlcvData> {
        const allCandles: OHLCV[] = [];
        let currentSince: number | undefined = undefined; // Start from latest data
        let remaining = desiredLimit;

        logger.info(`Starting paginated fetch for ${symbol}:${timeframe}. Target: ${desiredLimit} candles.`);

        try {
            while (remaining > 0 && allCandles.length < desiredLimit) {
                // Determine fetch limit (max 1000 or remaining)
                const fetchLimit = Math.min(remaining, this.MAX_EXCHANGE_LIMIT);

                // Fetch data
                const fetchedData = await this.exchange.fetchOHLCV(symbol, timeframe, currentSince, fetchLimit);

                if (!fetchedData || fetchedData.length === 0) {
                    logger.warn(`Fetch returned no data. Stopping pagination. Fetched ${allCandles.length}/${desiredLimit}.`);
                    break;
                }

                // Validate candles
                for (const candle of fetchedData) {
                    const [timestamp, open, high, low, close, volume] = candle.map(Number);
                    if (
                        isNaN(timestamp) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume) ||
                        open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 ||
                        high < low
                    ) {
                        logger.warn(`Invalid candle detected: ${JSON.stringify(candle)}`);
                        continue;
                    }
                    allCandles.push(candle);
                }

                // Sort to ensure ascending order (oldest first)
                const sortedData = [...fetchedData].sort((a, b) => (a[0] as number) - (b[0] as number));

                // Log sample candle for debugging
                if (allCandles.length <= 5) {
                    logger.debug(`Sample candle: ${JSON.stringify(sortedData[0])}`);
                }

                // Check timestamp continuity (e.g., 3m = 180,000ms)
                const timeframeMs = this.timeframeToMs(timeframe);
                for (let i = 1; i < sortedData.length; i++) {
                    const diff = (sortedData[i][0] as number) - (sortedData[i - 1][0] as number);
                    if (diff > timeframeMs * 1.5) {
                        logger.warn(`Timestamp gap detected: ${diff / 1000}s between candles at ${new Date(sortedData[i - 1][0] as number).toISOString()}`);
                    }
                }

                // Update 'currentSince' to oldest timestamp minus timeframe
                const oldestTimestamp = sortedData[0][0] as number;
                currentSince = oldestTimestamp - timeframeMs;

                // Update remaining count
                remaining = desiredLimit - allCandles.length;

                logger.info(`Fetched ${fetchedData.length} candles. Total collected: ${allCandles.length}. Remaining: ${remaining}.`);

                // Break if exchange returns less than requested and we haven't hit the limit
                if (fetchedData.length < fetchLimit && allCandles.length < desiredLimit) {
                    logger.warn(`Exchange returned ${fetchedData.length} candles, less than ${fetchLimit}. Assuming end of data.`);
                    break;
                }
            }
        } catch (error: any) {
            logger.error(`Error during paginated fetch for ${symbol}:${timeframe}`, {
                error: error.message,
                code: error.code || 'N/A',
                stack: error.stack,
            });
            throw error; // Rethrow to let index.backtest.ts handle
        }

        // Trim to desiredLimit, taking most recent candles
        const finalCandles = allCandles.slice(-desiredLimit);
        logger.info(`Final collected data length: ${finalCandles.length}.`);

        // Convert to OhlcvData
        const result = this.toOhlcvData(finalCandles);

        // Validate OhlcvData
        if (
            result.timestamps.some(t => isNaN(t)) ||
            result.highs.some(h => isNaN(h) || h <= 0) ||
            result.lows.some(l => isNaN(l) || l <= 0) ||
            result.closes.some(c => isNaN(c) || c <= 0) ||
            result.volumes.some(v => isNaN(v) || v < 0)
        ) {
            logger.error('Invalid OhlcvData after conversion');
            throw new Error('Invalid OhlcvData: Contains NaN or negative values');
        }

        logger.info(`Successfully fetched ${JSON.stringify(result)} candles for ${symbol}:${timeframe}`);
        return result;
    }

    static toTimeframeMs(timeframe: string): number {
        const unit = timeframe.slice(-1);
        const value = parseInt(timeframe.slice(0, -1), 10);
        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'w': return value * 7 * 24 * 60 * 60 * 1000;
            case 'M': return value * 30 * 24 * 60 * 60 * 1000; // Approximation
            default: throw new Error(`Unsupported timeframe unit: ${unit}`);
        }
    }

    private timeframeToMs(timeframe: string): number {
        return ExchangeService.toTimeframeMs(timeframe);
    }

    /**
     * validateSymbol checks if a symbol is supported by the exchange.
     */
    public async validateSymbol(symbol: string): Promise<boolean> {
        if (this.getSupportedSymbols.length < 1) {
            await this.loadSupportedSymbols()
        }

        return this.supportedSymbols.includes(symbol);
    }

    /**
     * Retrieves the latest closing price for a given symbol (uses primary timeframe).
     * @param symbol - The symbol to fetch the latest price for.
     * @returns The latest closing price or null if no data.
     */
    getLatestPrice(symbol: string): number | null {
        const candles = this.primaryOhlcvData[symbol];
        if (candles && candles.length > 0) {
            const close = candles[candles.length - 1][4];
            return close !== undefined ? Number(close) : null;
        }
        return null;
    }

    /**
     * Clears the OHLCV cache for secondary timeframes to prevent memory bloat.
     */
    clearCache(): void {
        this.ohlcvCache = {};
        logger.info('OHLCV cache cleared');
    }

    /**
     * Checks if the ExchangeService is initialized with data.
     * @returns True if primary OHLCV data is available for at least one symbol.
     */
    isInitialized(): boolean {
        return Object.keys(this.primaryOhlcvData).length > 0;
    }

    /**
     * Converts an array of OHLCV candles into the OhlcvData structure.
     * @param candles - Array of OHLCV candles.
     * @returns OhlcvData object with separate arrays for each OHLCV component.
     */
    public toOhlcvData(candles: OHLCV[]): OhlcvData {
        return {
            timestamps: candles.map(c => (Number(c[0]))).filter(v => !isNaN(v)),
            opens: candles.map(c => Number(c[1])).filter(v => !isNaN(v)),
            highs: candles.map(c => Number(c[2])).filter(v => !isNaN(v)),
            lows: candles.map(c => Number(c[3])).filter(v => !isNaN(v)),
            closes: candles.map(c => Number(c[4])).filter(v => !isNaN(v)),
            volumes: candles.map(c => Number(c[5])).filter(v => !isNaN(v)),
            length: candles.length,
        };
    }

    /**
     * Executes a function with retries and exponential backoff for transient errors.
     * @param fn - The function to execute.
     * @param retries - Number of retries.
     * @returns Result of the function.
     * @throws Last error if all retries fail.
     */
    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        let lastError: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const delay = 300 * Math.pow(2, i); // Exponential backoff
                logger.warn(`Attempt ${i + 1} failed, retrying in ${delay}ms`, { error: (error as Error).message });
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        logger.error(`Failed after ${retries} retries`, { error: (lastError as Error).message });
        throw lastError;
    }
}
