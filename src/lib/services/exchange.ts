import { config } from '../config/settings';
import ccxt, { type Num, type OHLCV, Exchange, Order, Position, Trade } from 'ccxt';
import { createLogger } from '../logger';
import type { OhlcvData } from '../../types';

/**
 * Logger instance for ExchangeService operations.
 * - Tagged with 'ExchangeService' for categorized logging.
 */
const logger = createLogger('ExchangeService');

/**
 * Manages interactions with the exchange (e.g., Bybit) using the CCXT library.
 * - Handles testnet/live mode switching, order placement, position management, and data fetching.
 * - Supports trailing stops (native or simulated) and dynamic position sizing for risk management.
 * - Integrates with configuration for seamless mode transitions and API credential management.
 */
export class ExchangeService {
    private exchange: Exchange;
    private primaryOhlcvData: { [symbol: string]: OHLCV[] } = {};
    private ohlcvCache: { [symbol: string]: { [timeframe: string]: OHLCV[] } } = {};
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};
    private supportedSymbols: string[] = [];
    private readonly MAX_EXCHANGE_LIMIT = 1000;
    public isLive: boolean;

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
        this.isLive = !config.exchange.testnet;
        logger.info('Initializing ExchangeService...', { exchange, liveMode: this.isLive });

        this.exchange = this.createExchange(exchange);
        if (this.isLive) {
            if (!config.exchange.apiKey || !config.exchange.apiSecret) {
                logger.error('Live mode requires EXCHANGE_API_KEY and EXCHANGE_API_SECRET');
                throw new Error('Missing live API credentials');
            }
            this.exchange.apiKey = config.exchange.apiKey;
            this.exchange.secret = config.exchange.apiSecret;
            logger.info('ExchangeService initialized in live mode');
        } else {
            this.exchange.options = { ...this.exchange.options, test: true };
            if (!config.exchange.testnetApiKey || !config.exchange.testnetApiSecret) {
                logger.error('Testnet mode requires EXCHANGE_TESTNET_API_KEY and EXCHANGE_TESTNET_API_SECRET');
                throw new Error('Missing testnet API credentials');
            }
            this.exchange.apiKey = config.exchange.testnetApiKey;
            this.exchange.secret = config.exchange.testnetApiSecret;
            logger.info('ExchangeService initialized in testnet mode');
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
            options: { defaultType: 'future' },
        }) as Exchange;
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
                const newData = await this.withRetries(
                    () => this.exchange.fetchOHLCV(symbol, timeframe, undefined, config.historyLength),
                    3
                );
                this.primaryOhlcvData[symbol] = newData;
                logger.info(`[${symbol}:${timeframe}] Updated OHLCV`, {
                    latestClose: newData[newData.length - 1]?.[4] ?? 'N/A',
                    candleCount: newData.length,
                });
                retryCount = 0;
            } catch (error) {
                retryCount++;
                logger.error(`[${symbol}:${timeframe}] Error fetching OHLCV (attempt ${retryCount}/${maxRetries})`, {
                    error: (error as Error).message,
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
        await this.loadSupportedSymbols();
        config.symbols.forEach(symbol => this.startPolling(symbol));
        logger.info('ExchangeService fully initialized', { symbolCount: this.supportedSymbols.length });
    }

    /**
     * Stops all polling intervals and clears resources.
     */
    public stopAll(): void {
        Object.keys(this.pollingIntervals).forEach(symbol => this.stopPolling(symbol));
        logger.info('All polling stopped');
    }

    /**
     * Fetches OHLCV data for a symbol and timeframe.
     * - Supports pagination for large data requests and validates data integrity.
     * - Uses cache to reduce API calls for frequently accessed timeframes.
     * @param symbol - Trading symbol (e.g., 'BTC/USDT').
     * @param timeframe - Timeframe (e.g., '1m', '1h').
     * @param since - Optional start timestamp (Unix ms).
     * @param until - Optional end timestamp (Unix ms).
     * @returns {Promise<OhlcvData>} OHLCV data object.
     * @throws {Error} If data fetching fails or validation fails.
     */
    public async getOHLCV(symbol: string, timeframe: string, since?: number, until?: number): Promise<OhlcvData> {
        try {
            if (!await this.validateSymbol(symbol)) {
                logger.error(`Invalid symbol: ${symbol}`);
                throw new Error(`Symbol ${symbol} is not supported`);
            }

            const cacheKey = `${symbol}:${timeframe}`;
            if (this.ohlcvCache[symbol]?.[timeframe] && !since && !until) {
                logger.debug(`Returning cached OHLCV for ${cacheKey}`);
                return this.toOhlcvData(this.ohlcvCache[symbol][timeframe]);
            }

            const fetchLimit = this.MAX_EXCHANGE_LIMIT;
            let allCandlesMap = new Map<number, OHLCV>();
            let currentSince = since;

            while (true) {
                const params = until ? { until } : {};
                const fetchedData = await this.withRetries(
                    () => this.exchange.fetchOHLCV(symbol, timeframe, currentSince, fetchLimit, params),
                    3
                );

                for (const candle of fetchedData) {
                    allCandlesMap.set(candle[0] as number, candle);
                }

                if (fetchedData.length === 0 || (until && fetchedData[fetchedData.length - 1][0]! >= until)) {
                    break;
                }

                currentSince = fetchedData[fetchedData.length - 1][0] as number;
                logger.debug(`Fetched ${fetchedData.length} candles for ${cacheKey}. Total collected: ${allCandlesMap.size}`);

                if (fetchedData.length < fetchLimit) {
                    logger.warn(`Exchange returned ${fetchedData.length} candles, less than ${fetchLimit}. Assuming end of data.`);
                    break;
                }
            }

            const finalCandles = Array.from(allCandlesMap.values()).sort((a, b) => (a[0] as number) - (b[0] as number));

            if (finalCandles.length > 0) {
                logger.info(`Final data range for ${cacheKey}: ${new Date(finalCandles[0][0] as number).toISOString()} to ${new Date(finalCandles[finalCandles.length - 1][0] as number).toISOString()}`);
            }

            const result = this.toOhlcvData(finalCandles);

            if (
                result.timestamps.some(t => isNaN(t)) ||
                result.highs.some(h => isNaN(h) || h <= 0) ||
                result.lows.some(l => isNaN(l) || l <= 0) ||
                result.closes.some(c => isNaN(c) || c <= 0) ||
                result.volumes.some(v => isNaN(v) || v < 0)
            ) {
                logger.error(`Invalid OhlcvData for ${cacheKey}: Contains NaN or negative values`);
                throw new Error('Invalid OhlcvData: Contains NaN or negative values');
            }

            for (let i = 1; i < result.timestamps.length; i++) {
                if (result.timestamps[i] <= result.timestamps[i - 1]) {
                    logger.error(`Timestamp order validation failed for ${cacheKey}: ${new Date(result.timestamps[i]).toISOString()} <= ${new Date(result.timestamps[i - 1]).toISOString()}`);
                    throw new Error('Timestamps not in ascending order');
                }
            }

            if (!this.ohlcvCache[symbol]) this.ohlcvCache[symbol] = {};
            this.ohlcvCache[symbol][timeframe] = finalCandles;
            return result;
        } catch (error: any) {
            logger.error(`Error fetching OHLCV for ${symbol}:${timeframe}`, { error: error.message });
            throw error;
        }
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
            logger.info(`Placed ${side} order for ${amount} ${symbol} in ${this.isLive ? 'live' : 'testnet'} mode`, {
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
                positionCount: activePositions.length,
                mode: this.isLive ? 'live' : 'testnet',
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
        try {
            const balance = await this.withRetries(() => this.exchange.fetchBalance(), 3);
            const total = balance?.total.total || 0;
            logger.info(`Fetched account balance: ${total} USDT in ${this.isLive ? 'live' : 'testnet'} mode`);
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
        const timestamps = candles.map(c => Number(c[0])).filter(v => !isNaN(v));
        const opens = candles.map(c => Number(c[1])).filter(v => !isNaN(v));
        const highs = candles.map(c => Number(c[2])).filter(v => !isNaN(v));
        const lows = candles.map(c => Number(c[3])).filter(v => !isNaN(v));
        const closes = candles.map(c => Number(c[4])).filter(v => !isNaN(v));
        const volumes = candles.map(c => Number(c[5])).filter(v => !isNaN(v));
        const length = Math.min(timestamps.length, opens.length, highs.length, lows.length, closes.length, volumes.length);

        return {
            timestamps: timestamps.slice(-length),
            opens: opens.slice(-length),
            highs: highs.slice(-length),
            lows: lows.slice(-length),
            closes: closes.slice(-length),
            volumes: volumes.slice(-length),
            length,
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
    private async withRetries<T>(fn: () => Promise<T>, retries: number = 3): Promise<T> {
        let lastError: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const delay = 300 * Math.pow(2, i);
                logger.warn(`Attempt ${i + 1} failed, retrying in ${delay}ms`, { error: (error as Error).message });
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        logger.error(`Failed after ${retries + 1} attempts`, { error: (lastError as Error).message });
        throw lastError;
    }

    /**
     * Converts a timeframe string to milliseconds.
     * - Supports units: 'm' (minutes), 'h' (hours), 'd' (days), 'w' (weeks), 'M' (months).
     * @param timeframe - Timeframe string (e.g., '1m', '1h').
     * @returns {number} Duration in milliseconds.
     * @throws {Error} If the timeframe unit is unsupported.
     */
    public static toTimeframeMs(timeframe: string): number {
        const unit = timeframe.slice(-1);
        const value = parseInt(timeframe.slice(0, -1), 10);
        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'w': return value * 7 * 24 * 60 * 60 * 1000;
            case 'M': return value * 30 * 24 * 60 * 60 * 1000;
            default:
                logger.error(`Unsupported timeframe unit: ${unit}`);
                throw new Error(`Unsupported timeframe unit: ${unit}`);
        }
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

    /**
     * Switches between testnet and live mode.
     * - Updates API credentials and exchange options dynamically.
     * @param liveMode - True for live mode, false for testnet.
     * @throws {Error} If required API credentials are missing for the selected mode.
     */
    public async switchMode(liveMode: boolean): Promise<void> {
        if (liveMode === this.isLive) {
            logger.info(`Already in ${liveMode ? 'live' : 'testnet'} mode, no changes needed`);
            return;
        }

        this.isLive = liveMode;
        this.stopAll(); // Stop existing polling
        this.clearCache(); // Clear cached data

        if (liveMode) {
            if (!config.exchange.apiKey || !config.exchange.apiSecret) {
                logger.error('Cannot switch to live mode: Missing EXCHANGE_API_KEY or EXCHANGE_API_SECRET');
                throw new Error('Missing live API credentials');
            }
            this.exchange.apiKey = config.exchange.apiKey;
            this.exchange.secret = config.exchange.apiSecret;
            this.exchange.options = { ...this.exchange.options, test: false };
            logger.info('Switched to live mode');
        } else {
            if (!config.exchange.testnetApiKey || !config.exchange.testnetApiSecret) {
                logger.error('Cannot switch to testnet mode: Missing EXCHANGE_TESTNET_API_KEY or EXCHANGE_TESTNET_API_SECRET');
                throw new Error('Missing testnet API credentials');
            }
            this.exchange.apiKey = config.exchange.testnetApiKey;
            this.exchange.secret = config.exchange.testnetApiSecret;
            this.exchange.options = { ...this.exchange.options, test: true };
            logger.info('Switched to testnet mode');
        }

        await this.initialize(); // Re-initialize with new mode
    }
}
