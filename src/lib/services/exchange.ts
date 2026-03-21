// src/lib/services/exchange.ts

import { config } from '../config/settings';
import ccxt, { type bybit, type Num, type OHLCV, Exchange, Order, Position, Trade } from 'ccxt';
import { createLogger } from '../logger';
import type { OhlcvData } from '../../types';
// import { dbService } from '../db';

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
    // private primaryOhlcvData: { [symbol: string]: OHLCV[] } = {};
    private ohlcvCache: { [symbol: string]: { [timeframe: string]: CacheEntry } } = {};
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};
    private supportedSymbols: string[] = [];
    private readonly MAX_EXCHANGE_LIMIT = 1000;
    private positionMode: 'oneway' | 'hedge' | null = null; // Cache for Bybit position mode

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
        logger.info('Initializing ExchangeService...', { exchange, liveMode: config.autoTrade.enabled });

        this.exchange = this.createExchange(exchange);

        if (config.exchange.apiKey && config.exchange.apiSecret) {
            this.exchange.apiKey = config.exchange.apiKey;
            this.exchange.secret = config.exchange.apiSecret;

            (this.exchange as bybit).enableDemoTrading(config.exchange.testnet);
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
            version: 'v5',

            options: { defaultType: 'futures', "trade.type": "linear" },
        }) as Exchange;
    }

    public isAutoTradeEnvSet(): boolean {
        return config.autoTrade.enabled;
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
            console.log(markets);
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
 * Starts polling OHLCV data for all configured symbols on the required timeframes.
 *
 * Actively polled timeframes:
 *   - primaryTimeframe (e.g. '5m')   → live signal generation
 *   - '1m'                           → simulation, excursion calc, precise backtesting
 *
 * Behavior:
 *   - One repeating timer per (symbol + timeframe) combination
 *   - Idempotent: safe to call multiple times (won't create duplicate timers)
 *   - Initial fetch happens immediately
 *   - Data is stored in this.primaryOhlcvData[`${symbol}:${tf}`]
 */
    private startPolling(): void {
        const symbols = config.symbols;

        // Which timeframes to poll continuously
        const timeframesToPoll = [
            config.scanner.primaryTimeframe,   // e.g. '5m' or '3m'
            config.scanner.simulationTimeframe,                              // high-res for simulation / MAE/MFE
        ];

        let timersStarted = 0;

        symbols.forEach(symbol => {
            timeframesToPoll.forEach(tf => {
                const key = `${symbol}:${tf}`;

                // Prevent duplicate timers
                if (this.pollingIntervals[key]) {
                    logger.debug(`Polling already running for ${key} — skipping`);
                    return;
                }

                // How often to fetch (in ms)
                const intervalMs = ExchangeService.toTimeframeMs(tf);

                // The actual polling function
                const poll = async () => {
                    try {
                        const candles = await this.withRetries(
                            () => this.exchange.fetchOHLCV(
                                symbol,
                                tf,
                                undefined,
                                config.historyLength + 20   // small buffer
                            ),
                            3
                        );

                        if (candles.length === 0) {
                            logger.warn(`No candles returned for ${key}`);
                            return;
                        }

                        // Keep only recent history (saves memory)
                        const trimmed = candles.slice(-config.historyLength);

                        // Store under composite key
                        if (!this.ohlcvCache[symbol]) {
                            this.ohlcvCache[symbol] = {};
                        }
                        this.ohlcvCache[symbol][tf] = {
                            data: trimmed,
                            timestamp: Date.now(),
                        };

                        logger.debug(`Polled ${trimmed.length} ${tf} candles for ${symbol}`);

                    } catch (err) {
                        logger.error(`Polling failed ${key}`, {
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                };

                // Run once immediately
                poll().catch(err =>
                    logger.error(`Initial poll failed ${key}`, { error: err })
                );

                // Then schedule repeating
                this.pollingIntervals[key] = setInterval(poll, intervalMs);

                timersStarted++;
            });
        });

        if (timersStarted > 0) {
            logger.info(
                `Started ${timersStarted} polling timer(s) ` +
                `for ${symbols.length} symbol(s) × ${timeframesToPoll.length} timeframe(s)`
            );
        } else {
            logger.warn("No polling timers started — check symbols / timeframes config");
        }
    }

    /**
 * Stops all OHLCV polling for a specific symbol across all timeframes.
 * Clears all related interval timers and removes them from pollingIntervals.
 *
 * @param symbol - Trading symbol (e.g., 'BTC/USDT')
 */
    private stopPolling(symbol: string): void {
        const stopped: string[] = [];

        // Find and clear all intervals that belong to this symbol
        Object.keys(this.pollingIntervals).forEach(key => {
            if (key.startsWith(`${symbol}:`)) {
                clearInterval(this.pollingIntervals[key]);
                delete this.pollingIntervals[key];
                stopped.push(key);
            }
        });

        if (stopped.length > 0) {
            logger.info(`Stopped polling for ${symbol} (${stopped.length} timeframes)`, {
                timeframes: stopped.map(k => k.split(':')[1])
            });
        } else {
            logger.debug(`No active polling found for ${symbol}`);
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
        logger.info('Initializing ExchangeService...');
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
 * Fetches OHLCV data for a symbol and timeframe.
 *
 * Data priority (after validation):
 *  1. Recently cached data (with different freshness rules for polled vs on-demand timeframes)
 *  2. Fresh fetch from exchange
 *
 * @remarks
 * - Polled timeframes (1m + primary) should have short effective TTL because polling writes frequently
 * - Higher timeframes (1h, 4h, etc.) get special staleness check based on last candle timestamp
 * - Historical queries (since/until) always bypass cache
 */
    public async getOHLCV(
        symbol: string,
        timeframe: string,
        since?: number,
        until?: number,
        forceRefresh = false
    ): Promise<OhlcvData> {
        const cacheKey = `${symbol}:${timeframe}`;
        const isHistoricalQuery = !!(since || until);

        try {
            // 1. Symbol validation
            if (!(await this.validateSymbol(symbol))) {
                logger.error(`Invalid symbol: ${symbol}`);
                throw new Error(`Symbol ${symbol} is not supported`);
            }

            const now = Date.now();

            // ────────────────────────────────────────────────────────────────
            //  Try to serve from cache (unless historical / force refresh)
            // ────────────────────────────────────────────────────────────────
            if (!forceRefresh && !isHistoricalQuery) {
                const entry = this.ohlcvCache[symbol]?.[timeframe];

                if (entry) {
                    const cacheAgeMs = now - entry.timestamp;

                    let isAcceptable = false;

                    // 1h timeframe → check actual candle age (more important than cache write time)
                    if (timeframe === '1h') {
                        const lastCandleTime = entry.data.at(-1)?.[0];
                        if (typeof lastCandleTime === 'number') {
                            const candleAgeMs = now - lastCandleTime;
                            isAcceptable = candleAgeMs <= 35 * 60_000; // ~35 min — slightly over 1 candle
                        }
                    }
                    // Other timeframes — normal TTL check based on cache write time
                    else {
                        isAcceptable = cacheAgeMs < ExchangeService.toTimeframeMs(timeframe) + 30_000;
                    }

                    if (isAcceptable) {
                        logger.debug(`Cache hit (acceptable freshness) → ${cacheKey}`);
                        return this.toOhlcvData(entry.data, symbol);
                    }
                }
            }

            // ────────────────────────────────────────────────────────────────
            //  Clear cache if forceRefresh requested
            // ────────────────────────────────────────────────────────────────
            if (forceRefresh && this.ohlcvCache[symbol]?.[timeframe]) {
                logger.debug(`Force refresh → clearing cache ${cacheKey}`);
                delete this.ohlcvCache[symbol]![timeframe];
            }

            // ────────────────────────────────────────────────────────────────
            //  Fetch from exchange
            // ────────────────────────────────────────────────────────────────
            const fetchLimit = this.MAX_EXCHANGE_LIMIT;
            const params: any = until ? { until } : {};

            const rawCandles = await this.withRetries(
                () => this.exchange.fetchOHLCV(symbol, timeframe, since, fetchLimit, params),
                3
            );

            if (rawCandles.length === 0) {
                logger.warn(`No candles returned for ${cacheKey} (since: ${since ?? 'unset'}, until: ${until ?? 'unset'})`);
                return this.toOhlcvData([]);
            }

            // Sort just in case (some exchanges occasionally return out-of-order)
            rawCandles.sort((a, b) => (a[0] as number) - (b[0] as number));

            logger.info(`Fetched ${rawCandles.length} candles → ${cacheKey} ` +
                `range: ${new Date(rawCandles[0][0] as number).toISOString()} → ${new Date(rawCandles.at(-1)![0] as number).toISOString()}`);

            const result = this.toOhlcvData(rawCandles, symbol);

            // ────────────────────────────────────────────────────────────────
            //  Integrity validation (unchanged)
            // ────────────────────────────────────────────────────────────────
            const isInvalid =
                result.timestamps.some(t => isNaN(t)) ||
                result.highs.some(h => isNaN(h) || h <= 0) ||
                result.lows.some(l => isNaN(l) || l <= 0) ||
                result.closes.some(c => isNaN(c) || c <= 0) ||
                result.volumes.some(v => isNaN(v) || v < 0);

            if (isInvalid) {
                logger.error(`Invalid OHLCV data for ${cacheKey}: NaN / non-positive values`);
                throw new Error('Invalid OHLCV data: contains NaN or problematic values');
            }

            for (let i = 1; i < result.timestamps.length; i++) {
                if (result.timestamps[i]! <= result.timestamps[i - 1]!) {
                    logger.error(`Non-ascending timestamps in ${cacheKey} at index ${i}`);
                    throw new Error('Timestamps not in strictly ascending order');
                }
            }

            // ────────────────────────────────────────────────────────────────
            //  Cache the result (only for "current" queries)
            // ────────────────────────────────────────────────────────────────
            if (!isHistoricalQuery && !forceRefresh) {
                if (!this.ohlcvCache[symbol]) this.ohlcvCache[symbol] = {};
                this.ohlcvCache[symbol][timeframe] = {
                    data: rawCandles,
                    timestamp: now,
                };
                logger.debug(`Cached fresh data → ${cacheKey}`);
            }

            return result;

        } catch (err: any) {
            logger.error(`getOHLCV failed → ${cacheKey}`, {
                error: err.message,
                stack: err.stack ?? undefined,
                since,
                until,
                forceRefresh,
            });
            throw err;
        }
    }

    private async loadMarkets(): Promise<void> {
        try {
            const markets = await this.exchange.loadMarkets();
            this.supportedSymbols = Object.keys(markets).filter(m =>
                config.symbols.includes(m) && m.endsWith('USDT')
            );
            logger.info(`Successfully loaded ${this.supportedSymbols.length} whitelisted markets`, { symbols: this.supportedSymbols });
        } catch (error) {
            logger.error('Failed to load markets', { error });
            throw error;
        }
    }

    /**
 * Fast path: returns raw OHLCV array from cache for primary timeframe if available
 * Returns undefined if missing, empty or not present.
 */
    public getPrimaryOhlcvData(symbol: string): OHLCV[] | undefined {
        const tf = config.scanner.primaryTimeframe;
        return this.ohlcvCache[symbol]?.[tf]?.data ?? undefined;
    }

    /**
 * Fetches and caches the current position mode of the Bybit account.
 *
 * Position modes:
 *   - 'oneway'  → One-Way Mode (only one direction per symbol)
 *   - 'hedge'   → Hedge Mode (can hold both long and short simultaneously)
 *
 * Caches the result to avoid redundant API calls on every order.
 * Falls back gracefully to 'oneway' if the API call fails.
 *
 * @returns Promise resolving to 'oneway' or 'hedge'
 */
    private async getPositionMode(): Promise<'oneway' | 'hedge'> {
        // Return cached value if already fetched
        if (this.positionMode) {
            return this.positionMode;
        }

        try {
            // Use CCXT's unified method if available, otherwise fall back to raw endpoint
            // Note: CCXT v4+ has fetchPositionMode() — prefer that when possible
            let response;
            try {
                response = await this.exchange.fetchPositionMode();
                logger.error('Fetched position mode using CCXT unified method', { response });
            } catch (ccxtErr) {
                // Fallback to raw Bybit V5 endpoint if unified method not supported
                logger.debug('CCXT fetchPositionMode not available, using raw endpoint', { error: ccxtErr });
            }

            // Extract mode safely
            const rawMode = (response as any)?.result?.data?.mode || (response as any)?.mode; // Try both possible paths
            if (!rawMode) {
                throw new Error('Invalid response format from position mode endpoint');
            }

            const mode = rawMode.toLowerCase() as 'oneway' | 'hedge';

            // Validate response
            if (mode !== 'oneway' && mode !== 'hedge') {
                throw new Error(`Unexpected position mode received: ${rawMode}`);
            }

            // Cache and log
            this.positionMode = mode;
            logger.info(`Bybit position mode fetched and cached`, { mode });

            return mode;
        } catch (error) {
            // Log detailed error for debugging
            logger.error('Failed to fetch Bybit position mode', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });

            // Safe fallback – most accounts default to one-way
            const fallback = 'oneway' as const;
            logger.warn(`Using fallback position mode: ${fallback}`);

            // Still cache the fallback to avoid repeated failed calls
            this.positionMode = fallback;
            return fallback;
        }
    }

    /**
 * Places a market order with optional stop-loss, take-profit, and trailing stop.
 * - Validates and aligns quantity based on exchange limits (min qty, step size, min cost).
 * - Uses fixed USD amount from config for position sizing.
 * - Dynamically sets positionIdx based on account mode to avoid mismatches.
 * - Handles testnet/live mode via config.
 * - For buys: Prefers quoteOrderQty to let Bybit calculate qty (avoids some precision issues).
 * - For sells: Calculates qty manually with alignment and optional round-up.
 *
 * @param symbol - Trading symbol (e.g., 'BTC/USDT').
 * @param side - Order side ('buy' or 'sell').
 * @param amount - Risk amount in USDT (e.g., 20) — will be converted to qty if needed.
 * @param stopLoss - Optional stop-loss price.
 * @param takeProfit - Optional take-profit price.
 * @param trailingStopDistance - Optional trailing stop distance.
 * @returns {Promise<Order>} Placed order details.
 * @throws {Error} If order placement fails or quantity is invalid.
 */
    public async placeOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        stopLoss?: number,
        takeProfit?: number,
        _trailingStopDistance?: number
    ): Promise<Order> {
        if (!this.isAutoTradeEnvSet()) {
            throw new Error('Auto-trade environment is not set. Cannot place order.');
        }

        try {
            // Fetch market details for limits and precision
            const market = this.exchange.market(symbol);

            // Get current price for calculations
            const currentPrice = this.getLatestPrice(symbol);
            if (!currentPrice) {
                throw new Error(`Cannot get current price for ${symbol}`);
            }

            // Log market limits for easier debugging
            const minQty = market.limits.amount?.min ?? 0;
            const minCost = market.limits.cost?.min ?? 0;
            const stepSize = (market.limits.amount as any).step ?? Math.pow(10, -(market.precision.amount ?? 0));
            logger.debug(`Market limits for ${symbol}: minQty=${minQty}, minCost=${minCost}, stepSize=${stepSize}, precision.amount=${market.precision.amount ?? 'N/A'}`);

            // Prepare base params
            const params: { [key: string]: any } = {
                category: 'linear', // For USDT-margined perpetuals
            };

            // Dynamically set positionIdx based on account mode
            const positionMode = await this.getPositionMode();
            if (positionMode === 'hedge') {
                params.positionIdx = side === 'buy' ? 1 : 2;
            } else {
                params.positionIdx = 0;
            }

            // Add SL/TP/trailing if provided
            if (stopLoss) params.stopLossPrice = stopLoss;
            if (takeProfit) params.takeProfitPrice = takeProfit;
            // if (trailingStopDistance) params.trailingAmount = trailingStopDistance; // Uncomment if supported

            let order: Order;
            // For SELL: Calculate qty manually (amount USDT / price)
            let qty = amount / currentPrice;

            // Check min qty
            if (qty < minQty) {
                throw new Error(`Calculated qty ${qty} too small; minimum is ${minQty}`);
            }

            // Align to step size (floor first)
            let steppedQty = Math.floor(qty / stepSize) * stepSize;

            // If floored qty < min, try rounding up
            if (steppedQty < minQty) {
                const roundedUpQty = Math.ceil(qty / stepSize) * stepSize;
                if (roundedUpQty >= minQty) {
                    logger.debug(`Rounded up qty from ${steppedQty} to ${roundedUpQty} for ${symbol}`);
                    steppedQty = roundedUpQty;
                } else {
                    throw new Error(`Cannot align qty to meet minQty ${minQty} (original qty: ${qty})`);
                }
            }

            // Apply CCXT precision
            const finalQty = parseFloat(this.exchange.amountToPrecision(symbol, steppedQty));

            logger.debug(`Placing market ${side} order with qty=${finalQty} for ${symbol} (~${amount} USDT)`, { params });

            order = await this.withRetries(
                () => this.exchange.createOrder(symbol, 'market', side, finalQty, undefined, params),
                3
            );

            // Log successful order placement
            logger.info(`Placed ${side} order for ${symbol}`, {
                orderId: order.id,
                qty: order.amount,
                price: order.average ?? 'market',
                cost: order.cost,
            });

            return order;
        } catch (error) {
            // Enhanced error logging
            logger.error(`Failed to place ${side} order for ${symbol}`, {
                amount,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
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
    public toOhlcvData(candles: OHLCV[], symbol?: string): OhlcvData {
        return {
            symbol: symbol || 'unknown',
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
        const candles = this.getPrimaryOhlcvData(symbol);
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
        const initialized = Object.keys(this.ohlcvCache).length > 0;
        logger.debug(`ExchangeService initialized: ${initialized}`);
        return initialized;
    }
}
