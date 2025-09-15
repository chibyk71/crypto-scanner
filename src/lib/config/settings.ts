
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

export const config = {
    env: process.env.ENV || 'dev',
    runtime_env: process.env.RUNTIME_ENV || 'cron',
    log_level: process.env.LOG_LEVEL || 'info',
    exchange: {
        name: process.env.EXCHANGE ?? 'bybit',
        apiKey: process.env.EXCHANGE_API_KEY ?? '',
        apiSecret: process.env.EXCHANGE_API_SECRET ?? '',
    },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN ?? '',
        chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    },
    database_url: process.env.DATABASE_URL ?? 'mysql://root:@localhost:3306/crypto_scanner',
    symbols: process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : ['BTC/USDT', 'ETH/USDT'],
    timeframe: process.env.TIMEFRAME ?? '1h',
    leverage: Number(process.env.LEVERAGE) || 1,
    historyLength: Number(process.env.HISTORY_LENGTH) || 200, // Number of historical candles to fetch
    pollingInterval: Number(process.env.POLL_INTERVAL) || 60000, // Default to 1 minutes
    heartBeatInterval: Number(process.env.HEARTBEAT_INTERVAL) || 20,
};

export type Config = typeof config;
