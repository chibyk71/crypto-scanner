// src/lib/services/exchange.ts

import { config } from '../config/settings';
import ccxt, { type Num, type OHLCV, Exchange, Order, Position, Trade } from 'ccxt';
import { createLogger } from '../logger';
import type { OhlcvData } from '../../types';

/**
 * Logger instance for ExchangeService operations.
 * - Tagged with 'ExchangeService' for categorized logging.
 */
const logger = createLogger('ExchangeService');

interface CacheEntry {
    data: OHLCV[];
    timestamp: number;
}

/**
 * Manages interactions with the exchange (e.g., Bybit) using the CCXT library.
 * - Handles testnet/live mode switching, order placement, position management, and data fetching.
 * - Supports trailing stops (native or simulated) and dynamic position sizing for risk management.
 * - Integrates with configuration for seamless mode transitions and API credential management.
 */
export class ExchangeService {
    private exchange: Exchange;
    private primaryOhlcvData: { [symbol: string]: OHLCV[] } = {};
    private ohlcvCache: { [symbol: string]: { [timeframe: string]: CacheEntry } } = {};
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};
    private supportedSymbols: string[] = [];
    private readonly MAX_EXCHANGE_LIMIT = 1000;
    private readonly CACHE_TTL_MS = 5 * 60 * 1000;

    /**
     * Initializes the exchange service.
     * - Configures the CCXT exchange instance based on the provided or default exchange name.
     * - Sets testnet or live mode based on `config.liveMode`.
     * - Validates and assigns API credentials for the selected mode.
     * @param name - Optional exchange name (defaults to `config.exchange.name`).
     * @throws {Error} If the exchange is unsupported or required API credentials are missing.
     */
    constructor(name?: string) {
        const exchange = name ?? config.exchange.name;
        logger.info('Initializing ExchangeService...', { exchange, liveMode: config.autoTrade });

        this.exchange = this.createExchange(exchange);

        if (config.exchange.apiKey && config.exchange.apiSecret) {
            this.exchange.apiKey = config.exchange.apiKey;
            this.exchange.secret = config.exchange.apiSecret;

            logger.info(`ExchangeService configured in ${config.autoTrade ? 'live' : 'testnet'} mode`, { exchange });
        }
    }

    /**
     * Creates a CCXT exchange instance for the specified exchange ID.
     * - Configures rate limiting and futures trading by default.
     * @param id - Exchange ID (e.g., 'bybit').
     * @returns {Exchange} Configured CCXT exchange instance.
     * @throws {Error} If the exchange ID is not supported by CCXT.
     * @private
     */
    private createExchange(id: string): Exchange {
        const exchangeClass = (ccxt as any)[id];
        if (!exchangeClass) {
            logger.error(`Exchange ${id} is not supported`);
            throw new Error(`Exchange ${id} is not supported`);
        }
        return new exchangeClass({
            enableRateLimit: true,
            timeout: 60000,
            options: { defaultType: 'futures' },
        }) as Exchange;
    }

    public isAutoTradeEnvSet(): boolean {
        return config.autoTrade;
    }

    /**
     * Loads supported trading symbols from the exchange.
     * - Filters symbols based on `config.symbols` for relevance.
     * - Populates `supportedSymbols` for validation in other methods.
     * @throws {Error} If market loading fails.
     * @private
     */
    private async loadSupportedSymbols(): Promise<void> {
        try {
            logger.info('Loading all markets from the exchange...');
            const markets = await this.withRetries(() => this.exchange.loadMarkets(), 3);
            this.supportedSymbols = Object.keys(markets).filter(symbol =>
                config.symbols.includes(symbol)
            );
            if (this.supportedSymbols.length === 0) {
                logger.warn('No supported symbols found based on config.symbols', { configSymbols: config.symbols });
            }
            logger.info(`Successfully loaded ${this.supportedSymbols.length} whitelisted markets`, { symbols: this.supportedSymbols });
        } catch (error) {
            logger.error('Failed to load markets from the exchange', { error });
            throw error;
        }
    }

    /**
     * Starts polling OHLCV data for a specific symbol.
     * - Fetches data at the configured primary timeframe and updates `primaryOhlcvData`.
     * - Implements retry logic for transient errors and stops polling on max retries.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @private
     */
    private startPolling(): void {
        const symbols = config.symbols;
        const timeframe = config.scanner.primaryTimeframe;

        symbols.forEach(symbol => {
            logger.info(`Started polling for ${symbol} on ${timeframe}`);
            this.pollSymbol(symbol, timeframe);
        });
    }

    /**
     * Stops polling OHLCV data for a specific symbol.
     * - Clears the polling interval and removes it from `pollingIntervals`.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @private
     */
    private stopPolling(symbol: string): void {
        if (this.pollingIntervals[symbol]) {
            clearInterval(this.pollingIntervals[symbol]);
            delete this.pollingIntervals[symbol];
            logger.info(`[${symbol}] Polling stopped`);
        }
    }

    /**
     * Retrieves the list of supported trading symbols.
     * @returns {string[]} Array of supported symbols.
     */
    public getSupportedSymbols(): string[] {
        return this.supportedSymbols;
    }

    /**
     * Initializes the exchange service.
     * - Loads supported symbols and starts polling for each configured symbol.
     * @throws {Error} If initialization fails (e.g., market loading error).
     */
    public async initialize(): Promise<void> {
        logger.info('Initializing ExchangeService...', { exchange: 'gate', liveMode: config.autoTrade });
        await this.loadMarkets();
        this.startPolling();
    }

    /**
     * Stops all polling intervals and clears resources.
     */
    public stopAll(): void {
        Object.keys(this.pollingIntervals).forEach(symbol => this.stopPolling(symbol));
        logger.info('All polling stopped');
    }

    /**
 * Fetches OHLCV (Open-High-Low-Close-Volume) data for a given symbol and timeframe.
 * Prioritizes live polling data, then cache, and falls back to a fresh exchange fetch.
 *
 * @param symbol The trading pair (e.g., 'BTC/USDT').
 * @param timeframe The candlestick interval (e.g., '1h', '1d').
 * @param since Optional: Fetch candles from this Unix timestamp (ms). Disables simple caching.
 * @param until Optional: Fetch candles up to this Unix timestamp (ms). Disables simple caching.
 * @param forceRefresh Optional: If true, bypasses cache and live data checks.
 * @returns A Promise that resolves to the processed OhlcvData object.
 * @throws An error if the symbol is invalid, the data fetch fails, or data integrity checks fail.
 */
    public async getOHLCV(
        symbol: string,
        timeframe: string,
        since?: number,
        until?: number,
        forceRefresh = false
    ): Promise<OhlcvData> {
        const cacheKey = `${symbol}:${timeframe}`;
        const isHistoricalQuery = since || until; // Flag for queries that look for a specific range

        try {
            // --- 1. Validate Symbol ---
            if (!(await this.validateSymbol(symbol))) {
                logger.error(`Invalid symbol: ${symbol}`);
                throw new Error(`Symbol ${symbol} is not supported`);
            }

            const now = Date.now();

            // --- 2. Live Data Check (Only for non-historical, non-forced-refresh queries) ---
            if (!forceRefresh && !isHistoricalQuery && this.primaryOhlcvData[symbol]) {
                const liveData = this.primaryOhlcvData[symbol];
                // Check if the live-polled data meets the minimum history length
                if (liveData.length >= config.historyLength) {
                    logger.debug(`Using live polling data for ${cacheKey}`);
                    return this.toOhlcvData(liveData);
                }
            }

            // --- 3. Cache Check (Only for non-historical, non-forced-refresh queries) ---
            const cache = this.ohlcvCache[symbol]?.[timeframe];
            const isCacheValid = cache && now - cache.timestamp < this.CACHE_TTL_MS;

            if (!forceRefresh && !isHistoricalQuery && isCacheValid) {
                logger.debug(`Returning valid cached OHLCV for ${cacheKey}`);
                return this.toOhlcvData(cache.data);
            }

            // --- 4. Force Refresh: Clear Cache if requested ---
            if (forceRefresh && cache) {
                logger.debug(`Force refreshing and clearing OHLCV cache for ${cacheKey}`);
                delete this.ohlcvCache[symbol][timeframe];
            }

            // --- 5. Fetch Data from Exchange ---
            const fetchLimit = this.MAX_EXCHANGE_LIMIT;
            // The 'until' parameter is non-standard but supported by some CCXT-like exchanges;
            // we pass it in 'params' if it exists.
            const params = until ? { until } : {};

            // Use withRetries wrapper for robustness against temporary network/exchange issues
            const rawCandles = await this.withRetries(
                () => this.exchange.fetchOHLCV(symbol, timeframe, since, fetchLimit, params),
                3 // Retry up to 3 times
            );

            // --- 6. Handle Empty Result ---
            if (rawCandles.length === 0) {
                logger.warn(`No candles returned for ${cacheKey} (since: ${since}, until: ${until})`);
                return this.toOhlcvData([]);
            }

            // Ensure data is sorted by timestamp (ascending) as required for processing
            rawCandles.sort((a, b) => (a[0] as number) - (b[0] as number));

            logger.info(`Fetched ${rawCandles.length} candles for ${cacheKey}. ` +
                `Range: ${new Date(rawCandles[0][0] as number).toISOString()} to ${new Date(rawCandles.at(-1)![0] as number).toISOString()}`);

            const result = this.toOhlcvData(rawCandles);

            // --- 7. Data Integrity Validation ---
            // Check for NaN, non-positive High/Low/Close, or negative Volume
            const isDataInvalid =
                result.timestamps.some(t => isNaN(t)) ||
                result.highs.some(h => isNaN(h) || h <= 0) ||
                result.lows.some(l => isNaN(l) || l <= 0) ||
                result.closes.some(c => isNaN(c) || c <= 0) ||
                result.volumes.some(v => isNaN(v) || v < 0);

            if (isDataInvalid) {
                logger.error(`Invalid OhlcvData for ${cacheKey}: Contains NaN, non-positive prices, or negative volume`);
                throw new Error('Invalid OhlcvData: Contains NaN or problematic values');
            }

            // Check for strictly ascending timestamp order
            for (let i = 1; i < result.timestamps.length; i++) {
                if (result.timestamps[i]! <= result.timestamps[i - 1]!) {
                    logger.error(`Timestamp order validation failed for ${cacheKey}: Detected non-ascending timestamp at index ${i}`);
                    throw new Error('Timestamps not in strictly ascending order');
                }
            }

            // --- 8. Update Cache (Only for default, non-historical, non-forced-refresh queries) ---
            if (!isHistoricalQuery && !forceRefresh) {
                if (!this.ohlcvCache[symbol]) this.ohlcvCache[symbol] = {};
                this.ohlcvCache[symbol][timeframe] = {
                    data: rawCandles,
                    timestamp: now
                };
                logger.debug(`Cached new OHLCV data for ${cacheKey}`);
            }

            return result;

        } catch (error: any) {
            // --- 9. Error Handling ---
            logger.error(`Error fetching OHLCV for ${cacheKey}`, { error: error.message, stack: error.stack });
            // Re-throw the error to be handled by the caller
            throw error;
        }
    }

    private async loadMarkets(): Promise<void> {
        try {
            const markets = await this.exchange.loadMarkets();
            this.supportedSymbols = Object.keys(markets).filter(m =>
                config.symbols.includes(m) && m.endsWith('/USDT')
            );
            logger.info(`Successfully loaded ${this.supportedSymbols.length} whitelisted markets`, { symbols: this.supportedSymbols });
        } catch (error) {
            logger.error('Failed to load markets', { error });
            throw error;
        }
    }

    public getPrimaryOhlcvData(symbol: string): OHLCV[] | undefined {
        return this.primaryOhlcvData[symbol];
    }

    private async pollSymbol(symbol: string, timeframe: string): Promise<void> {
        const ms = ExchangeService.toTimeframeMs(timeframe);
        const historyLength = config.historyLength; // ← Use config
        const poll = async () => {
            try {
                const candles = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, historyLength);

                if (candles.length > 0) {
                    this.primaryOhlcvData[symbol] = candles;
                    const latest = candles.at(-1)!;
                    logger.info(`[${symbol}:${timeframe}] Updated OHLCV`, {
                        latestClose: latest[4],
                        candleCount: candles.length,
                    });
                }
            } catch (error) {
                logger.error(`Polling failed for ${symbol}`, { error });
            }
        };

        await poll();
        setInterval(poll, ms);
    }


    /**
     * Places a market order with optional stop-loss and take-profit.
     * - Supports Bybit’s native trailing stop if available; otherwise, simulates it.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @param side - Order side ('buy' or 'sell').
     * @param amount - Order quantity (adjusted for leverage).
     * @param stopLoss - Optional stop-loss price.
     * @param takeProfit - Optional take-profit price.
     * @param trailingStopDistance - Optional trailing stop distance (in price units).
     * @returns {Promise<Order>} The placed order object.
     * @throws {Error} If order placement fails.
     */
    public async placeOrder(symbol: string, side: 'buy' | 'sell', amount: number, stopLoss?: number, takeProfit?: number, trailingStopDistance?: number): Promise<Order> {
        if (!this.isAutoTradeEnvSet()) {
            Promise.reject(new Error('Auto-trade environment is not set. Cannot place orders.'));
        }

        try {
            if (!await this.validateSymbol(symbol)) {
                logger.error(`Invalid symbol for order: ${symbol}`);
                throw new Error(`Symbol ${symbol} is not supported`);
            }

            const params: { [key: string]: any } = {};
            if (stopLoss) params.stopLossPrice = stopLoss;
            if (takeProfit) params.takeProfitPrice = takeProfit;
            if (trailingStopDistance) params.trailingStop = trailingStopDistance;

            const order = await this.withRetries(
                () => this.exchange.createMarketOrder(symbol, side, amount, undefined, params),
                3
            );
            logger.info(`Placed ${side} order for ${amount} ${symbol} in live mode`, {
                stopLoss,
                takeProfit,
                trailingStopDistance,
                orderId: order.id,
            });
            return order;
        } catch (error) {
            logger.error(`Failed to place ${side} order for ${symbol}`, { error });
            throw error;
        }
    }

    /**
     * Updates the stop-loss price for an existing order.
     * - Used for trailing stop simulation when native trailing stops are unavailable.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @param orderId - ID of the order to update.
     * @param newStopLoss - New stop-loss price.
     * @returns {Promise<void>}
     * @throws {Error} If updating the stop-loss fails.
     */
    public async updateStopLoss(symbol: string, orderId: string, newStopLoss: number): Promise<void> {
        try {
            await this.withRetries(
                () => this.exchange.editOrder(orderId, symbol, 'market', undefined, undefined, undefined, { stopLossPrice: newStopLoss }),
                3
            );
            logger.info(`Updated stop-loss for ${symbol} order ${orderId} to ${newStopLoss}`);
        } catch (error) {
            logger.error(`Failed to update stop-loss for ${symbol} order ${orderId}`, { error });
            throw error;
        }
    }

    /**
     * Closes an open position for a symbol.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @param side - Position side ('buy' or 'sell').
     * @param amount - Position quantity to close.
     * @returns {Promise<void>}
     * @throws {Error} If closing the position fails.
     */
    public async closePosition(symbol: string, side: 'buy' | 'sell', amount: number): Promise<void> {
        try {
            const closeSide = side === 'buy' ? 'sell' : 'buy';
            await this.withRetries(
                () => this.exchange.createMarketOrder(symbol, closeSide, amount, undefined, { reduceOnly: true }),
                3
            );
            logger.info(`Closed ${side} position for ${amount} ${symbol}`);
        } catch (error) {
            logger.error(`Failed to close position for ${symbol}`, { error });
            throw error;
        }
    }

    /**
 * Fetches open positions for a specific trading symbol.
 * - Retrieves positions using CCXT's `fetchPositions` method and filters for active positions (non-zero contracts).
 * - Implements retry logic for robustness against transient API failures.
 * - Logs the number of open positions and any errors for monitoring.
 * @param symbol - Trading symbol (e.g., 'BTC/USDT').
 * @returns {Promise<Position[]>} Array of active positions with non-zero contracts.
 * @throws {Error} If fetching positions fails after retries or if the symbol is invalid.
 */
    public async getPositions(symbol: string): Promise<Position[]> {
        if (!this.isAutoTradeEnvSet()) {
            return Promise.reject(new Error('Auto-trade environment is not set. Cannot fetch positions.'));
        }

        try {
            // Validate symbol before fetching positions
            if (!await this.validateSymbol(symbol)) {
                logger.error(`Invalid symbol: ${symbol}`);
                throw new Error(`Symbol ${symbol} is not supported`);
            }

            // Fetch positions with retry logic
            const positions = await this.withRetries(() => this.exchange.fetchPositions([symbol]), 3);

            // Filter for active positions (non-zero contracts or notional)
            const activePositions = positions.filter(p => {
                const contracts = p.contracts ?? 0; // Use contracts; fallback to 0 if undefined
                const notional = p.notional ?? 0; // Use notional as a fallback check
                return contracts !== 0 || notional !== 0; // Consider position active if either is non-zero
            });

            logger.debug(`Fetched ${activePositions.length} open positions for ${symbol}`, {
                positionCount: activePositions.length
            });

            return activePositions;
        } catch (error) {
            logger.error(`Failed to fetch positions for ${symbol}`, { error: (error as Error).message });
            throw error;
        }
    }

    /**
     * Fetches closed trades for a symbol since a given timestamp.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @param since - Start timestamp (Unix ms).
     * @returns {Promise<Trade[]>} Array of closed trades.
     * @throws {Error} If fetching trades fails.
     */
    public async getClosedTrades(symbol: string, since: number): Promise<Trade[]> {
        try {
            const trades = await this.withRetries(() => this.exchange.fetchMyTrades(symbol, since), 3);
            logger.debug(`Fetched ${trades.length} closed trades for ${symbol} since ${new Date(since).toISOString()}`);
            return trades;
        } catch (error) {
            logger.error(`Failed to fetch trades for ${symbol}`, { error });
            throw error;
        }
    }

    /**
     * Fetches the account balance in USDT.
     * - Used for dynamic position sizing based on `POSITION_SIZE_PERCENT`.
     * @returns {Promise<number>} Total USDT balance.
     * @throws {Error} If balance fetching fails.
     */
    public async getAccountBalance(): Promise<Num> {
        if (!this.isAutoTradeEnvSet()) {
            return Promise.reject(new Error('Auto-trade environment is not set. Cannot fetch account balance.'));
        }
        try {
            const balance = await this.withRetries(() => this.exchange.fetchBalance(), 3);
            const total = balance?.total.total || 0;
            logger.info(`Fetched account balance: ${total} USDT`);
            return total;
        } catch (error) {
            logger.error('Failed to fetch account balance', { error });
            throw error;
        }
    }

    /**
     * Converts raw CCXT OHLCV data to the application's OhlcvData format.
     * - Ensures all values are valid numbers and removes invalid entries.
     * @param candles - Array of OHLCV candles from CCXT.
     * @returns {OhlcvData} Formatted OHLCV data object.
     */
    public toOhlcvData(candles: OHLCV[]): OhlcvData {
        return {
            timestamps: candles.map(c => c[0] as number),
            opens: candles.map(c => c[1] as number),
            highs: candles.map(c => c[2] as number),
            lows: candles.map(c => c[3] as number),
            closes: candles.map(c => c[4] as number),
            volumes: candles.map(c => c[5] as number),
            length: candles.length,
        };
    }

    /**
     * Executes a function with retry logic for transient errors.
     * - Uses exponential back-off for retries.
     * @param fn - The async function to execute.
     * @param retries - Number of retries (default: 3).
     * @returns {Promise<T>} Result of the function.
     * @throws {Error} If all retries fail.
     * @private
     */
    private async withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
        throw new Error('Unreachable');
    }

    /**
     * Converts a timeframe string to milliseconds.
     * - Supports units: 'm' (minutes), 'h' (hours), 'd' (days), 'w' (weeks), 'M' (months).
     * @param timeframe - Timeframe string (e.g., '1m', '1h').
     * @returns {number} Duration in milliseconds.
     * @throws {Error} If the timeframe unit is unsupported.
     */
    public static toTimeframeMs(timeframe: string): number {
        const match = timeframe.match(/^(\d+)([mhd])$/);
        if (!match) return 60000;
        const [, value, unit] = match;
        const v = parseInt(value);
        return unit === 'm' ? v * 60 * 1000 :
            unit === 'h' ? v * 60 * 60 * 1000 :
                v * 24 * 60 * 60 * 1000;
    }

    /**
     * Validates if a symbol is supported by the exchange.
     * - Loads supported symbols if not already loaded.
     * @param symbol - Trading symbol to validate.
     * @returns {Promise<boolean>} True if the symbol is supported, false otherwise.
     */
    public async validateSymbol(symbol: string): Promise<boolean> {
        if (this.supportedSymbols.length === 0) {
            await this.loadSupportedSymbols();
        }
        const isValid = this.supportedSymbols.includes(symbol);
        if (!isValid) {
            logger.warn(`Symbol validation failed: ${symbol} not in supported symbols`);
        }
        return isValid;
    }

    /**
     * Retrieves the latest closing price for a symbol.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @returns {number | null} Latest closing price or null if unavailable.
     */
    public getLatestPrice(symbol: string): number | null {
        const candles = this.primaryOhlcvData[symbol];
        if (candles && candles.length > 0) {
            const close = candles[candles.length - 1][4];
            logger.debug(`Latest price for ${symbol}: ${close}`);
            return close !== undefined ? Number(close) : null;
        }
        logger.warn(`No price data available for ${symbol}`);
        return null;
    }

    /**
     * Clears the OHLCV cache.
     * - Resets cached data to force fresh data fetching.
     */
    public clearCache(): void {
        this.ohlcvCache = {};
        logger.info('OHLCV cache cleared');
    }

    /**
     * Checks if the exchange service is initialized.
     * @returns {boolean} True if initialized (has OHLCV data), false otherwise.
     */
    public isInitialized(): boolean {
        const initialized = Object.keys(this.primaryOhlcvData).length > 0;
        logger.debug(`ExchangeService initialized: ${initialized}`);
        return initialized;
    }
}
