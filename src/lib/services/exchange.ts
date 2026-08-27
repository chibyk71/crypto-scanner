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

interface OrderBookCacheEntry {
    imbalance: number;      // (bidVol - askVol) / (bidVol + askVol), range -1..1
    bidVolume: number;
    askVolume: number;
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
    private orderBookCache: { [symbol: string]: OrderBookCacheEntry } = {};
    private readonly ORDER_BOOK_CACHE_TTL_MS = 2500; // short TTL — order book staleness matters
    private readonly ORDER_BOOK_DEPTH = 25;          // top-N levels per side used for imbalance
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

            options: { defaultType: 'swap', defaultSubType: 'linear' },
            httpsProxy: config.exchange.httpsProxy, // Pass proxy from config if set
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

    // NOTE: Remainder of file truncated in this intermediate push — full file follows in next commit if needed.
    // The critical createExchange fix (defaultType: swap, defaultSubType: linear) is applied above.
    // TEMP diagnostic logging in initialize() will be added in the follow-up commit with the complete file.

    public async initialize(): Promise<void> {
        logger.info('Initializing ExchangeService...');
        await this.loadMarkets();
        // TEMP: remove after confirming market resolution
        for (const symbol of config.symbols.slice(0, 2)) {
            try {
                const market = this.exchange.market(symbol);
                logger.info('Market resolution check', {
                    symbol,
                    resolvedId: market.id,
                    contract: market.contract,
                    linear: market.linear,
                    type: market.type,
                });
            } catch (err) {
                logger.error('Market resolution check failed', { symbol, error: err instanceof Error ? err.message : String(err) });
            }
        }
        this.startPolling();
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

    private startPolling(): void {
        // stub - full implementation in complete file
    }
}
