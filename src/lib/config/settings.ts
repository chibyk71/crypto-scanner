
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

export const config = {
    exchange: {
        apiKey: process.env.EXCHANGE_API_KEY ?? '',
        apiSecret: process.env.EXCHANGE_API_SECRET ?? '',
    },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN ?? '',
        chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    },
    database_url: process.env.DATABASE_URL ?? './alerts.db',
    symbols: process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : ['BTC/USDT', 'ETH/USDT'],
    timeframe: process.env.PUBLIC_TIMEFRAME ?? '1m',
    leverage: Number(process.env.PUBLIC_LEVERAGE) || 1,
    historyLength: 100, // Number of historical candles to fetch
    pollingInterval: Number(process.env.PUBLIC_POLL_INTERVAL) || 300000, // Default to 5 minutes
};
