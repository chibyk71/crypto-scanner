// src/lib/server/services/exchange.js
// This file defines the ExchangeService class, responsible for interacting with
// a cryptocurrency exchange via the CCXT library. It manages market data (OHLCV),
// polling for real-time updates, and tracks supported symbols for trading.

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
    // Store OHLCV data for each symbol in memory
    private ohlcvData: { [symbol: string]: OHLCV[] } = {};
    // Track polling intervals for each symbol to manage real-time updates
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};
    // Store supported symbols as a Set for efficient lookup and iteration
    private supportedSymbols: Set<string> = new Set();

    /**
     * Constructor for ExchangeService. Initializes the CCXT exchange instance
     * with the configured exchange name and settings (e.g., rate limiting).
     */
    constructor() {
        logger.info('Initializing ExchangeService...', { exchange: config.exchange.name });
        this.exchange = this.createExchange(config.exchange.name);
    }

    /**
     * Creates a CCXT exchange instance based on the provided exchange ID.
     * @param id - The ID of the exchange (e.g., 'bybit') to instantiate
     * @returns {Exchange} A configured CCXT exchange instance
     * @throws {Error} If the exchange ID is not supported by CCXT
     */
    private createExchange(id: string): Exchange {
        const exchangeClass = (ccxt as any)[id];
        if (!exchangeClass) {
            logger.error(`Exchange ${id} is not supported`);
            throw new Error(`Exchange ${id} is not supported`);
        }
        // Configure the exchange with rate limiting and a timeout of 30 seconds
        return new exchangeClass({ enableRateLimit: true, timeout: 30000 }) as Exchange;
    }

    /**
     * Loads all available markets from the exchange and populates the supportedSymbols Set.
     * This ensures we have an up-to-date list of symbols the exchange supports.
     * @returns {Promise<void>} Resolves when markets are loaded, or logs error on failure
     */
    private async loadSupportedSymbols(): Promise<void> {
        try {
            logger.info('Loading all markets from the exchange...');
            const markets = await this.exchange.loadMarkets();
            // Extract symbol names from market data and store in Set
            this.supportedSymbols = new Set(Object.keys(markets));
            logger.info(`Successfully loaded ${this.supportedSymbols.size} markets`);
        } catch (error) {
            // Log critical error if market loading fails, but don't throw to allow partial operation
            logger.error('Failed to load markets from the exchange', { error });
        }
    }

    /**
     * Returns the Set of supported symbols. Ensures symbols are loaded if not already.
     * @returns {Set<string>} A Set of supported symbol strings
     */
    public getSupportedSymbols(): Set<string> {
        // Load symbols if the Set is empty (lazy initialization)
        if (this.supportedSymbols.size === 0) {
            logger.info('Supported symbols not loaded yet, loading now...');
            this.loadSupportedSymbols();
        }
        return this.supportedSymbols;
    }

    /**
     * Initializes the ExchangeService by fetching initial OHLCV data for the given symbols
     * and starting polling for real-time updates.
     * @param symbols - Array of symbols to initialize (e.g., ['BTC/USDT', 'ETH/USDT'])
     * @returns {Promise<void>} Resolves when initialization is complete, or skips unsupported symbols
     */
    async initialize(symbols: string[]): Promise<void> {
        // Load supported symbols first to validate input symbols
        await this.loadSupportedSymbols();

        // Process each symbol in the provided list
        for (const symbol of symbols) {
            // Check if the symbol is supported by the exchange
            if (!this.supportedSymbols.has(symbol)) {
                logger.error(`Symbol ${symbol} is not supported by the exchange. Skipping`);
                continue;
            }

            try {
                // Fetch initial historical OHLCV data for the symbol
                this.ohlcvData[symbol] = await this.exchange.fetchOHLCV(
                    symbol,
                    config.timeframe,
                    undefined,
                    config.historyLength
                );
                logger.info(`Fetched initial OHLCV for ${symbol}`, {
                    candles: this.ohlcvData[symbol].length
                });
                // Start polling for real-time updates
                this.startPolling(symbol);
            } catch (error) {
                // Log error but continue with other symbols
                logger.error(`Error fetching initial OHLCV for ${symbol}`, { error });
            }
        }
    }

    /**
     * Starts polling for real-time OHLCV data updates for the given symbol.
     * Polling occurs at the configured interval (default: 5 minutes).
     * @param symbol - The symbol to poll (e.g., 'BTC/USDT')
     * @returns {Promise<void>} Resolves immediately after setting up the polling interval
     */
    private async startPolling(symbol: string): Promise<void> {
        const maxRetries = 3;
        let retryCount = 0;

        // Set up a polling interval to fetch updated OHLCV data
        const interval = setInterval(async () => {
            try {
                // Fetch latest OHLCV data for the symbol
                const newData = await this.exchange.fetchOHLCV(
                    symbol,
                    config.timeframe,
                    undefined,
                    config.historyLength
                );
                this.ohlcvData[symbol] = newData;
                // Log success with the latest closing price for monitoring
                logger.info(`[${symbol}] Updated OHLCV`, {
                    latestClose: newData[newData.length - 1][4]
                });
                retryCount = 0; // Reset retry count on successful fetch
            } catch (error) {
                retryCount++;
                // Log error with retry attempt information
                logger.error(`[${symbol}] Error fetching OHLCV (attempt ${retryCount}/${maxRetries})`, {
                    error
                });
                if (retryCount >= maxRetries) {
                    // Stop polling after max retries and notify via Telegram
                    logger.error(`[${symbol}] Max retries reached, stopping polling`);
                    this.stopPolling(symbol);
                    new TelegramService().sendMessage(
                        `⚠️ ${symbol} polling stopped after ${maxRetries} failures`
                    );
                }
            }
        }, config.pollingInterval || 300000); // Default to 5 minutes if not configured

        // Store the interval for later cleanup
        this.pollingIntervals[symbol] = interval;
        logger.info(`Started polling for ${symbol}`);
    }

    /**
     * Stops polling for the specified symbol by clearing its interval.
     * @param symbol - The symbol to stop polling for
     */
    stopPolling(symbol: string): void {
        if (this.pollingIntervals[symbol]) {
            // Clear the polling interval and remove from tracking
            clearInterval(this.pollingIntervals[symbol]);
            delete this.pollingIntervals[symbol];
            logger.info(`[${symbol}] Polling stopped`);
        }
    }

    /**
     * Stops all polling intervals for all symbols, used during shutdown.
     */
    stopAll(): void {
        // Iterate through all active polling intervals and stop them
        Object.keys(this.pollingIntervals).forEach((symbol) => this.stopPolling(symbol));
        logger.info('All polling stopped');
    }

    /**
     * Retrieves the historical OHLCV data for a given symbol.
     * @param symbol - The symbol to fetch OHLCV data for
     * @returns {OHLCV[]} Array of OHLCV data or empty array if none exists
     */
    getOHLCV(symbol: string): OHLCV[] {
        return this.ohlcvData[symbol] || [];
    }

    /**
     * Retrieves the latest closing price for a given symbol.
     * @param symbol - The symbol to fetch the latest price for
     * @returns {number | null} The latest closing price or null if no data
     */
    getLatestPrice(symbol: string): number | null {
        const candles = this.ohlcvData[symbol];
        if (candles && candles.length > 0) {
            const close = candles[candles.length - 1][4];
            return close !== undefined ? Number(close) : null;
        }
        return null;
    }
}
