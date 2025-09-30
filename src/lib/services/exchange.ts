// src/lib/server/services/exchange.js

// Import required dependencies
import { config } from '../config/settings';
import ccxt, { type OHLCV, Exchange } from 'ccxt';
import { TelegramService } from './telegram';
import { createLogger } from '../logger';

// Initialize logger with 'ExchangeService' label for structured logging
const logger = createLogger('ExchangeService');

export class ExchangeService {
    // Private instance of the CCXT exchange client
    private exchange: Exchange;
    // Store OHLCV data for the primary timeframe (config.timeframe)
    private primaryOhlcvData: { [symbol: string]: OHLCV[] } = {};
    // Store data fetched for non-primary timeframes to serve for the current scan cycle
    // Structure: { symbol: { timeframe: OHLCV[] } }
    private ohlcvCache: { [symbol: string]: { [timeframe: string]: OHLCV[] } } = {};
    // Track polling intervals for each symbol (only for primary timeframe)
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};
    // Store supported symbols as an Array
    private supportedSymbols: Array<string> = [];

    /**
     * Constructor for ExchangeService. Initializes the CCXT exchange instance
     * with the configured exchange name and settings (e.g., rate limiting).
     */
    constructor() {
        logger.info('Initializing ExchangeService...', { exchange: config.exchange.name });
        this.exchange = this.createExchange(config.exchange.name);
    }

    // --- Private Helper Methods ---

    private createExchange(id: string): Exchange {
        const exchangeClass = (ccxt as any)[id];
        if (!exchangeClass) {
            logger.error(`Exchange ${id} is not supported`);
            throw new Error(`Exchange ${id} is not supported`);
        }
        // Increase timeout for potentially slow exchanges and ensure rate limiting is active
        return new exchangeClass({ enableRateLimit: true, timeout: 60000 }) as Exchange;
    }

    private async loadSupportedSymbols(): Promise<void> {
        try {
            logger.info('Loading all markets from the exchange...');
            const markets = await this.exchange.loadMarkets();
            // Filter symbols based on the whitelist in config.symbols
            this.supportedSymbols = Object.keys(markets).filter((symbol) => {
                return config.symbols.includes(symbol);
            });
            logger.info(`Successfully loaded ${this.supportedSymbols.length} whitelisted markets`);
        } catch (error) {
            logger.error('Failed to load markets from the exchange (critical)', { error });
            // Re-throw to prevent the application from starting without market data
            throw error;
        }
    }

    // --- Public Interface Methods ---

    public getSupportedSymbols(): Array<string> {
        // Since loadSupportedSymbols is called in initialize, this is fine for late access.
        return this.supportedSymbols;
    }

    /**
     * Initializes the ExchangeService by fetching initial OHLCV data for the primary timeframe
     * and starting polling for real-time updates.
     */
    async initialize(): Promise<void> {
        // Load supported symbols first
        await this.loadSupportedSymbols();

        const promises = this.supportedSymbols.map(async (symbol) => {
            try {
                // Fetch initial historical OHLCV data for the PRIMARY timeframe
                this.primaryOhlcvData[symbol] = await this.exchange.fetchOHLCV(
                    symbol,
                    config.timeframe, // Use the primary timeframe
                    undefined,
                    config.historyLength
                );
                logger.info(`Fetched initial OHLCV for ${symbol} (${config.timeframe})`, {
                    candles: this.primaryOhlcvData[symbol].length
                });
                this.startPolling(symbol);
            } catch (error) {
                logger.error(`Error fetching initial OHLCV for ${symbol} (${config.timeframe})`, { error });
            }
        });

        // Wait for all initial fetches and polling to start
        await Promise.all(promises);
        logger.info('ExchangeService initialization complete.');
    }

    /**
     * Starts polling for real-time OHLCV data updates for the given symbol.
     * Polling only occurs for the primary timeframe (config.timeframe).
     * @param symbol - The symbol to poll (e.g., 'BTC/USDT')
     */
    private startPolling(symbol: string): void {
        const maxRetries = 3;
        let retryCount = 0;
        const timeframe = config.timeframe; // Use the configured primary timeframe

        if (this.pollingIntervals[symbol]) return; // Prevent duplicate polling

        const interval = setInterval(async () => {
            try {
                // Fetch latest OHLCV data for the symbol
                const newData = await this.exchange.fetchOHLCV(
                    symbol,
                    timeframe,
                    undefined,
                    config.historyLength
                );
                this.primaryOhlcvData[symbol] = newData;
                logger.info(`[${symbol}:${timeframe}] Updated OHLCV`, {
                    latestClose: newData[newData.length - 1][4]
                });
                retryCount = 0; // Reset retry count on successful fetch
            } catch (error) {
                retryCount++;
                logger.error(`[${symbol}:${timeframe}] Error fetching OHLCV (attempt ${retryCount}/${maxRetries})`, {
                    error: (error as Error).message // Use error message for cleaner logs
                });
                if (retryCount >= maxRetries) {
                    logger.error(`[${symbol}:${timeframe}] Max retries reached, stopping polling`);
                    this.stopPolling(symbol);
                    new TelegramService().sendMessage(
                        `⚠️ **${symbol}** polling stopped after ${maxRetries} failures on **${timeframe}** timeframe.`
                    ).catch(err => logger.error('Failed to send Telegram notification', { err }));
                }
            }
        }, config.pollingInterval || 60000); // Default to 1 minute polling interval (standard for 5m+ TF)

        this.pollingIntervals[symbol] = interval;
        logger.info(`Started polling for ${symbol} on ${timeframe}`);
    }

    /**
     * Stops polling for the specified symbol by clearing its interval.
     */
    stopPolling(symbol: string): void {
        if (this.pollingIntervals[symbol]) {
            clearInterval(this.pollingIntervals[symbol]);
            delete this.pollingIntervals[symbol];
            logger.info(`[${symbol}] Polling stopped`);
        }
    }

    /**
     * Stops all polling intervals for all symbols, used during shutdown.
     */
    stopAll(): void {
        Object.keys(this.pollingIntervals).forEach((symbol) => this.stopPolling(symbol));
        logger.info('All polling stopped');
    }

    /**
     * Retrieves the historical OHLCV data for a given symbol and timeframe.
     * This is the crucial update to support multi-timeframe analysis.
     *
     * @param symbol - The symbol (e.g., 'BTC/USDT')
     * @param timeframe - The requested timeframe (e.g., '1h', '4h'). Defaults to config.timeframe.
     * @returns {Promise<OHLCV[]>} Array of OHLCV data.
     */
    async getOHLCV(symbol: string, timeframe?: string): Promise<OHLCV[]> {
        const targetTimeframe = timeframe || config.timeframe;
        const defaultHistory = config.historyLength ?? 200;

        // 1. Primary Timeframe: Data is continuously polled and stored in primaryOhlcvData
        if (targetTimeframe === config.timeframe) {
            return this.primaryOhlcvData[symbol] || [];
        }

        // 2. Cache Check: Check if data for this secondary timeframe is already in the cache
        if (this.ohlcvCache[symbol]?.[targetTimeframe]) {
            return this.ohlcvCache[symbol][targetTimeframe];
        }

        // 3. On-Demand Fetch: Fetch data for the secondary timeframe
        try {
            const data = await this.exchange.fetchOHLCV(
                symbol,
                targetTimeframe,
                undefined,
                // Use a smaller history length for secondary TFs to reduce load, if desired
                // For simplicity, we use the defaultHistory length.
                defaultHistory
            );

            // Store in cache for subsequent requests in the same scan cycle
            this.ohlcvCache[symbol] = this.ohlcvCache[symbol] || {};
            this.ohlcvCache[symbol][targetTimeframe] = data;

            logger.info(`Fetched OHLCV for secondary TF: ${symbol}:${targetTimeframe}`, { candles: data.length });
            return data;
        } catch (error) {
            logger.error(`Error fetching OHLCV for secondary TF ${symbol}:${targetTimeframe}`, { error });
            return [];
        }
    }

    /**
     * Retrieves the latest closing price for a given symbol (always uses the primary timeframe).
     * @param symbol - The symbol to fetch the latest price for
     * @returns {number | null} The latest closing price or null if no data
     */
    getLatestPrice(symbol: string): number | null {
        const candles = this.primaryOhlcvData[symbol];
        if (candles && candles.length > 0) {
            const close = candles[candles.length - 1][4];
            return close !== undefined ? Number(close) : null;
        }
        return null;
    }

    isInitialized(): boolean {
        return Object.keys(this.primaryOhlcvData).length > 0;
    }
}
