import { config } from '../config/settings';
import ccxt, { type OHLCV, Exchange } from 'ccxt';
import { TelegramService } from './telegram';

export class ExchangeService {
    private exchange: Exchange;
    private ohlcvData: { [symbol: string]: OHLCV[] } = {};
    private pollingIntervals: { [symbol: string]: NodeJS.Timeout } = {};

    /**
     * Initializes the ExchangeService by creating a CCXT Bybit exchange instance.
     * The instance is configured with the API key and secret from the server
     * config, and rate limiting is enabled.
     */
    constructor() {
        this.exchange = this.createExchange(config.exchange.name);
    }

    /**
     * Creates a CCXT exchange instance based on the given id.
     * @param id the id of the exchange to create
     * @returns a CCXT exchange instance
     * @throws if the exchange is not supported
     */
    private createExchange(id: string): Exchange {
        const exchangeClass = (ccxt as any)[id];
        if (!exchangeClass) throw new Error(`Exchange ${id} is not supported`);
        return new exchangeClass({ enableRateLimit: true, timeout: 30000 }) as Exchange;
    }

    /**
     * Initializes the ExchangeService by fetching initial historical OHLCV data and
     * starting polling for each symbol in the given list.
     * @param symbols the list of symbols to initialize
     */
    async initialize(symbols: string[]): Promise<void> {
        for (const symbol of symbols) {
            // Fetch initial historical OHLCV data
            this.ohlcvData[symbol] = await this.exchange.fetchOHLCV(
                symbol,
                config.timeframe,
                undefined,
                config.historyLength
            );

            // Start polling for each symbol
            this.startPolling(symbol);
        }
    }

    /**
     * Starts polling for the given symbol at the configured polling interval.
     * @param symbol the symbol to start polling for
     */
    private async startPolling(symbol: string): Promise<void> {
        const maxRetries = 3;
        let retryCount = 0;

        const interval = setInterval(async () => {
            try {
                const newData = await this.exchange.fetchOHLCV(
                    symbol,
                    config.timeframe,
                    undefined,
                    config.historyLength
                );
                this.ohlcvData[symbol] = newData;
                console.log(`[${symbol}] Updated OHLCV, latest close: ${newData[newData.length - 1][4]}`);
                retryCount = 0; // Reset retries on success
            } catch (error) {
                retryCount++;
                console.error(`[${symbol}] Error fetching OHLCV (attempt ${retryCount}/${maxRetries}):`, error);
                if (retryCount >= maxRetries) {
                    console.error(`[${symbol}] Max retries reached, stopping polling`);
                    this.stopPolling(symbol);
                    // Notify via Telegram
                    new TelegramService().sendMessage(`⚠️ ${symbol} polling stopped after ${maxRetries} failures`);
                }
            }
        }, config.pollingInterval || 300000);

        this.pollingIntervals[symbol] = interval;
    }


    /**
     * Stops the polling interval for the given symbol.
     * @param symbol the symbol to stop polling for
     */
    stopPolling(symbol: string): void {
        if (this.pollingIntervals[symbol]) {
            clearInterval(this.pollingIntervals[symbol]);
            delete this.pollingIntervals[symbol];
            console.log(`[${symbol}] Polling stopped`);
        }
    }
    /**
     * Stops all polling intervals. Useful for shutting down the service.
     */
    stopAll(): void {
        Object.keys(this.pollingIntervals).forEach((symbol) => this.stopPolling(symbol));
    }

    /**
     * Returns the historical OHLCV data for a given symbol, or an empty array if polling hasn't started yet.
     * @param symbol - The symbol to fetch the OHLCV data for.
     * @returns The historical OHLCV data, or an empty array if polling hasn't started yet.
     */
    getOHLCV(symbol: string): OHLCV[] {
        return this.ohlcvData[symbol] || [];
    }

    /**
     * Returns the latest price for a given symbol, or null if there are no candles yet.
     * @param symbol - The symbol to fetch the latest price for.
     * @returns The latest price, or null if there are no candles yet.
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
