# Crypto Trading Scanner

## Overview

The **Crypto Trading Scanner** is a TypeScript-based application designed to monitor cryptocurrency markets, generate trade signals, and check user-defined alerts. It integrates with any exchange via the CCXT library to fetch OHLCV (Open, High, Low, Close, Volume) data, applies technical analysis using a customizable trading strategy, and sends notifications via Telegram. The application is built for reliability, with features like concurrent processing, error retries, cooldowns to prevent alert spam, and structured logging for monitoring.

The system is structured around two main components:
- **MarketScanner**: Handles periodic scanning of trading symbols, generates trade signals based on technical indicators, and checks database-driven alerts.
- **Worker**: Serves as the entry point, initializing services and starting the scanner with lock management to prevent concurrent runs.

This project is ideal for traders and developers looking to automate market monitoring and alerting for cryptocurrency trading pairs.

## Features

- **Real-Time Market Scanning**: Scans configured symbols (e.g., BTC/USDT, ETH/USDT) every 15 seconds to generate buy/sell signals.
- **Technical Analysis**: Uses indicators like EMA, RSI, MACD, Stochastic, ATR, Bollinger Bands, and OBV to generate signals with confidence levels, stop-loss, and take-profit.
- **Database-Driven Alerts**: Checks user-defined alerts stored in a database, supporting conditions like price thresholds and EMA crosses.
- **Telegram Notifications**: Sends alerts for trade signals and triggered database alerts via Telegram.
- **Concurrency and Rate Limiting**: Processes multiple symbols concurrently with jitter to avoid API rate limits.
- **Error Handling**: Implements retries with exponential backoff for transient errors and graceful shutdown.
- **Structured Logging**: Uses Winston to log events to file and console for monitoring and debugging.
- **Lock Management**: Prevents concurrent runs using a lock file to ensure system stability.
- **Configurable**: Supports customization of scan intervals, concurrency, cooldowns, and more via configuration files.

## Prerequisites

- **Node.js**: Version 18 or higher
- **TypeScript**: For compiling the codebase
- **Exchange API Access**: API key and secret (Optional) (configured in `src/lib/server/config/settings.ts`)
- **Telegram Bot**: Bot token and chat ID for notifications (configured in `src/lib/server/services/telegram.ts`)
- **Database**: A database (e.g., SQLite) with a schema for storing alerts (implemented in `src/lib/server/db.ts`)
- **Dependencies**: Install via `npm install` (see Dependencies section)

## Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/chibyk71/crypto-scanner.git
   cd crypto-trading-scanner
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```
   Key dependencies include:
   - `ccxt`: For interacting with exchanges
   - `drizzle`: For database management
   - `winston`: For logging
   - Other dependencies listed in `package.json`

3. **Configure Environment**:
   - Set up Telegram bot credentials in `src/lib/server/services/telegram.ts`.
   - Configure your database connection in `src/lib/server/db.ts`.

4. **Set Up Database**:
   - Ensure your database is running and accessible.
   - Create a table for alerts with columns: `id`, `symbol`, `condition`, `targetPrice`, `note`, and `status` (schema depends on `dbService` implementation).

5. **Build the Project**:
   ```bash
   npm run build
   ```
   This compiles TypeScript to JavaScript in the `dist` directory.

## Usage

1. **Start the Application**:
   ```bash
   npm start
   ```
   This runs `dist/index.js`, which should call `startWorker()` from `src/lib/server/worker.ts`.

2. **Monitor Logs**:
   - Logs are written to `logs/worker.log` and output to the console.
   - Check logs for initialization status, scan progress, and errors.

3. **Receive Notifications**:
   - Trade signals and triggered alerts are sent to the configured Telegram chat.
   - Signals include buy/sell recommendations, confidence, price, stop-loss, take-profit, and reasons.
   - Alerts include condition, price, indicators, and estimated ROI.

4. **Stop the Application**:
   - Press `Ctrl+C` to gracefully shut down, stopping scans and releasing the lock file.

## File Structure

```
crypto-trading-scanner/
├── src/
|   ├── index.ts              # Entry point, starts worker 
│   ├── lib/
│   │   ├── config/
│   │   │   └── settings.ts          # Client config (symbols, timeframe, etc.)
│   │   ├── db.ts                # Database service for alerts
│   │   ├── scanner.ts           # Core scanning logic (MarketScanner)
│   │   ├── worker.ts            # Entry point to start the application
│   │   ├── services/
│   │   │   ├── exchange.ts      # Exchange data fetching (Bitget via CCXT)
│   │   │   └── telegram.ts      # Telegram notification service
│   │   │── strategy.ts          # Trading strategy with technical indicators
│   │   └── indicators.ts            # Technical indicator calculations
├── logs/
│   └── worker.log                   # Structured logs
├── package.json                     # Dependencies and scripts
├── tsconfig.json                    # TypeScript configuration
└── README.md                        # This file
```

## Configuration

- **Client Config** (`src/lib/config/settings.ts`):
  - `symbols`: Array of trading pairs (e.g., `['BTC/USDT', 'ETH/USDT']`)
  - `timeframe`: Candle timeframe (e.g., `'1m'` for 1-minute candles)
  - `historyLength`: Number of historical candles to fetch
  - `pollingInterval`: Interval for updating OHLCV data (ms)
  - `apiKey`: Exchange API key
  - `secret`: Exchange API secret

- **Scanner Options** (`src/lib/server/scanner.ts`):
  - `intervalMs`: Scan cycle interval (default: 15000ms)
  - `concurrency`: Max concurrent symbols (default: 3)
  - `cooldownMs`: Alert cooldown per symbol (default: 5 minutes)
  - `jitterMs`: Random delay for API calls (default: 250ms)
  - `retries`: Retries for errors (default: 1)
  - `heartbeatEvery`: Heartbeat frequency (default: every 20 scans)
  - `requireAtrFeasibility`: Check ATR-based volatility (default: true)

## Technical Details

- **Exchange Integration**: Uses CCXT to connect to any Exchange, fetching OHLCV data with rate limiting and timeout handling.
- **Strategy**: Generates signals using EMA, RSI, MACD, Stochastic, ATR, Bollinger Bands, and OBV. Supports configurable risk-reward targets (default: 3%).
- **Alerts**: This project does not provide a user interface for creating alerts. Instead, alerts can be configured externally via database entries or integrated with a companion project. It checks database alerts for conditions like price thresholds or EMA crosses, with notifications sent via Telegram.
- **Concurrency**: Processes up to 3 symbols concurrently with jitter to avoid API rate limits.
- **Error Handling**: Retries transient errors with exponential backoff and logs issues for debugging.
- **Logging**: Winston logs in JSON format to `logs/worker.log` and console.

## Contributing

Contributions are welcome! To contribute:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/your-feature`).
3. Commit your changes (`git commit -m "Add your feature"`).
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a pull request with a detailed description of your changes.

Please ensure your code follows the existing style, includes tests if applicable, and updates documentation.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.

## Contact

For questions or support, open an issue on GitHub or contact the maintainer at [chibyk089@gmail.com].
