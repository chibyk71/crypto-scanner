# Crypto Scanner

A comprehensive cryptocurrency trading scanner and alert system built with TypeScript. It fetches real-time and historical market data from exchanges via CCXT, performs multi-timeframe technical analysis using indicators like RSI, EMA, MACD, and more, generates trade signals, manages custom alerts, and sends notifications via Telegram. Includes backtesting capabilities for strategy evaluation and a REST API for alert management.

## Features

- **Multi-Timeframe Analysis**: Analyzes data from primary (e.g., 3m) and higher timeframes (e.g., 1h) for trend confluence.
- **Technical Indicators**: Supports SMA, EMA, RSI, MACD, Stochastic, ATR, Bollinger Bands, OBV, ADX, and crossover detection.
- **Trade Signal Generation**: Weighted scoring system for buy/sell/hold signals with confidence levels, stop-loss, take-profit, and trailing stops.
- **Custom Alerts**: User-defined conditions (e.g., price > X, RSI crosses above Y) evaluated against market data, with cooldowns.
- **Telegram Integration**: Sends trade signals and alert notifications; interactive bot for creating/editing/deleting alerts.
- **Backtesting**: Simulates trading on historical data with metrics like win rate, Sharpe ratio, profit factor, and equity curve.
- **REST API**: Endpoints for managing alerts (create, read, update, delete).
- **Database Persistence**: Uses MySQL (via Drizzle ORM) for storing alerts, locks, and heartbeats.
- **Concurrency Control**: File or database locking to prevent overlapping scans in cron/scheduled environments.
- **Configurable Modes**: Run in periodic scanning mode (e.g., for servers) or single-scan mode (e.g., for cron jobs).
- **Error Handling & Retries**: Robust retries for API calls, logging with Winston.

## Architecture Overview

- **ExchangeService**: Handles CCXT integration for fetching OHLCV data, polling, and symbol validation.
- **Strategy**: Core logic for signal generation using indicators and multi-timeframe filters.
- **MarketScanner**: Orchestrates scanning symbols, generating signals, evaluating alerts, and sending notifications.
- **AlertEvaluatorService**: Evaluates custom alert conditions against OHLCV data.
- **TelegramService**: Sends messages and photos to Telegram chats.
- **TelegramBotController**: Interactive bot for alert management via commands.
- **DatabaseService**: Manages MySQL connections and queries for alerts, locks, and heartbeats.
- **Backtest Module**: Simulates trades on historical data with detailed metrics.
- **API Server**: Simple HTTP server for alert CRUD operations.
- **Worker**: Entry point that initializes services, acquires locks, and starts scanning.

The system supports environments like local development, servers (periodic mode), and cron jobs (single mode with locking).

## Installation

1. **Clone the Repository**:
   ```
   git clone https://github.com/chibyk71/crypto-scanner.git
   cd crypto-scanner
   ```

2. **Install Dependencies**:
   ```
   npm install
   ```

3. **Set Up Environment Variables**:
   Copy `.env.example` to `.env` and fill in your values (see [Configuration](#configuration) for details).
   ```
   cp .env.example .env
   ```

4. **Database Setup**:
   - Ensure MySQL is running and accessible.
   - Run migrations (if needed):
     ```
     npm run db:generate
     npm run db:migrate
     ```
   - Use `npm run db:studio` for a web-based DB explorer.

5. **Build the Project**:
   ```
   npm run build
   ```

## Usage

### Running the Scanner

- **Development Mode** (with auto-reload):
  ```
  npm run dev
  ```

- **Production Mode**:
  ```
  npm start
  ```

- **Backtesting**:
  ```
  npm run backtest
  ```
  This runs a backtest on configured symbols and timeframes, logging results.

- **GitHub Actions/Cron Mode**:
  Set `RUNTIME_ENV=cron` in `.env` or environment variables to use single-scan mode with database locking.
  ```
  npm run start:github
  ```

### Telegram Bot Commands

Interact with the bot via Telegram:
- `/createalert`: Start creating a new alert (interactive workflow for symbol, timeframe, conditions).
- `/listalerts`: List active alerts.
- `/editalert`: Edit an existing alert.
- `/deletealert`: Delete an alert.
- `/help`: Show available commands.

### REST API Endpoints

The API runs on the configured `API_PORT` (default: 3000).

- **GET /alerts**: Retrieve all alerts.
- **POST /alerts**: Create a new alert (body: `{ symbol, conditions, timeframe?, status?, note? }`).
- **GET /alerts/:id**: Get a specific alert by ID.
- **PUT /alerts/:id**: Update an alert (body: `{ status, conditions?, timeframe?, note? }`).
- **DELETE /alerts/:id**: Delete an alert.

Static files (e.g., UI) are served from `/public`.

### Configuration

Configure via `.env` file (see `.env.example` for all options):

- **General**:
  - `ENV`: 'dev' | 'prod' | 'test' (default: 'dev').
  - `LOG_LEVEL`: 'error' | 'warn' | 'info' | ... (default: 'info').

- **Database**:
  - `DATABASE_URL`: MySQL connection URL (e.g., 'mysql://user:pass@localhost:3306/dbname').

- **Exchange**:
  - `EXCHANGE`: Exchange ID (e.g., 'bybit').
  - `EXCHANGE_API_KEY` & `EXCHANGE_API_SECRET`: Optional for authenticated access.

- **Telegram**:
  - `TELEGRAM_BOT_TOKEN`: Bot token.
  - `TELEGRAM_CHAT_ID`: Chat ID for notifications.

- **Symbols & Timeframes**:
  - `SYMBOLS`: Comma-separated list (e.g., 'BTC/USDT,ETH/USDT').
  - `TIMEFRAME`: Primary timeframe (e.g., '3m').
  - `HTF_TIMEFRAME`: Higher timeframe (e.g., '1h').

- **Scanner**:
  - `POLL_INTERVAL`: Scan interval in ms (default: 60000).
  - `HEARTBEAT_INTERVAL`: Cycles between heartbeats (default: 60).

- **Strategy**:
  - `ATR_MULTIPLIER`: For stop-loss (default: 1.5).
  - `RISK_REWARD_TARGET`: Target R:R ratio (default: 2).
  - `TRAILING_STOP_PERCENT`: Trailing stop % (default: 3).

- **Backtest**:
  - `BACKTEST_START_DATE`, `BACKTEST_END_DATE`: Date range.
  - `BACKTEST_TIMEFRAME`: Timeframe for backtest.
  - `BACKTEST_SYMBOLS`: Symbols to test.
  - `BACKTEST_CYCLES_SKIP`: Cycles to skip.

- **Other**:
  - `LEVERAGE`: Trading leverage (default: 1).
  - `LOCK_TYPE`: 'file' | 'database' (default: 'database').
  - `SCANNER_MODE`: 'single' | 'periodic' (default: 'periodic').
  - `API_PORT`: API server port (default: 3000).

## Backtesting

The backtest module (`backtest.ts`) simulates trading on historical data:
- Fetches OHLCV for configured symbols/timeframes.
- Applies strategy signals with fees, slippage, and cooldowns.
- Outputs metrics: PnL, win rate, max drawdown, Sharpe ratio, profit factor, expectancy, etc.
- Logs trade details and equity curve.

Run with `npm run backtest`. Customize via `.env` backtest variables.

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/new-feature`.
3. Commit changes: `git commit -am 'Add new feature'`.
4. Push to the branch: `git push origin feature/new-feature`.
5. Submit a pull request.

Run tests: `npm test`.
Lint: `npm run test:lint`.
Prettier: `npm run fix:prettier`.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [CCXT](https://github.com/ccxt/ccxt) for exchange integration.
- [technicalindicators](https://github.com/anandanand84/technicalindicators) for TA calculations.
- [Drizzle ORM](https://orm.drizzle.team/) for database management.
- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) for Telegram support.
- [Winston](https://github.com/winstonjs/winston) for logging.
- [Zod](https://github.com/colinhacks/zod) for validation.