# Crypto Scanner

A comprehensive, production-grade cryptocurrency trading scanner and alert system built with TypeScript. It fetches real-time and historical market data from exchanges via CCXT, performs multi-timeframe technical analysis using a wide range of indicators (RSI, EMA, MACD, Stochastic, ATR, Bollinger Bands, ADX, OBV, etc.), generates high-confidence trade signals, manages fully customizable user alerts, and delivers rich notifications via Telegram. The system includes advanced simulation/backtesting capabilities, machine learning integration for continuous adaptation, and a REST API for alert management.

## Features

- **Multi-Timeframe Analysis**: Combines primary (e.g., 3m) and higher timeframes (e.g., 1h) for robust trend confluence and filtering.

- **Rich Technical Indicators**: Full suite including SMA, EMA, RSI, MACD, Stochastic, ATR, Bollinger Bands, OBV, ADX, VWMA, VWAP, momentum, and engulfing pattern detection.

- **Intelligent Signal Generation**: Point-based scoring system with confidence levels, dynamic stop-loss, take-profit, trailing stops, and excursion-aware adjustments.

- **Custom User Alerts**: Powerful condition builder supporting complex logic (crossovers, thresholds, ranges) with per-alert cooldowns.

- **Telegram Integration**: Real-time signal and alert notifications with excursion insights; fully interactive bot for creating, editing, and deleting alerts.

- **Advanced Simulation Engine**: High-fidelity trade simulation with partial TPs, trailing stops, MFE/MAE tracking, and precise R-multiple calculation.

- **Machine Learning Loop**: Continuous learning from simulations with 5-tier labeling; excursion features for risk-aware predictions.

- **Backtesting Suite**: Detailed performance metrics (win rate, Sharpe ratio, profit factor, max drawdown, expectancy) with equity curve analysis.

- **REST API**: Secure endpoints for programmatic alert management.

- **Database Persistence**: MySQL via Drizzle ORM for alerts, locks, heartbeats, and denormalized symbol statistics.

- **Concurrency Safety**: File or database locking to prevent overlapping runs in scheduled environments.

- **Flexible Modes**: Periodic scanning (servers), single-run (cron/GitHub Actions), with configurable concurrency and jitter.

- **Robust Error Handling**: Retries, graceful degradation, comprehensive logging with Winston.

## Architecture Overview

- **ExchangeService**: Unified CCXT wrapper for real-time polling, OHLCV fetching, and symbol validation.

- **Strategy**: Core multi-timeframe signal engine with scoring, risk management, and excursion integration.

- **MarketScanner**: Central orchestrator managing scan cycles, concurrency, alerts, simulation, and live trading.

- **AutoTradeService**: Safe live execution with excursion-based filtering and dynamic sizing.

- **AlertEvaluatorService**: Evaluates user-defined conditions against market data.

- **TelegramBotController**: Interactive bot for alert management and system control.

- **DatabaseService**: Type-safe MySQL operations with connection pooling and retry logic.

- **MLService**: Random Forest classifier with persistent model, excursion features, and automatic retraining.

- **simulateTrade**: High-precision simulation with full lifecycle support.

- **API Server**: Lightweight HTTP server for alert CRUD operations.

- **Worker**: Entry point with lock acquisition and mode selection.

The system is designed for reliability, extensibility, and long-term adaptation in volatile crypto markets.

## Installation

1. **Clone the Repository**:

```bash

git clone https://github.com/chibyk71/crypto-scanner.git

cd crypto-scanner

```

2. **Install Dependencies**:

```bash

npm install

```

3. **Configure Environment**:

Copy the example and fill in your values:

```bash

cp .env.example .env

```

See [Configuration](#configuration) for all options.

4. **Database Setup**:

- Ensure MySQL is running.

- Run migrations:

```bash

npm run db:generate

npm run db:migrate

```

- Optional: Launch Drizzle Studio for DB exploration:

```bash

npm run db:studio

```

5. **Build the Project**:

```bash

npm run build

```

## Usage

### Running the Scanner

- **Development Mode** (with hot-reload):

```bash

npm run dev

```

- **Production Mode**:

```bash

npm start

```

- **Simulation/Backtesting**:

```bash

npm run backtest

```

Analyzes historical performance with detailed metrics.

- **Cron / GitHub Actions Mode**:

Set `SCANNER_MODE=single` and `LOCK_TYPE=database` in `.env`.

```bash

npm run start:github

```

### Telegram Bot Commands

Interact with your private bot:

- `/start` or `/help`: List all commands

- `/create_alert`: Interactive alert creation (symbol → timeframe → conditions)

- `/alerts`: List active alerts with pagination

- `/edit_alert`: Modify an existing alert

- `/delete_alert`: Remove an alert

- `/ml_status`: View ML model health and label distribution

- `/ml_samples`: Per-symbol training sample summary

- `/ml_performance`: Overall win rate and metrics

- `/excursions BTC/USDT`: View MAE/MFE stats for a symbol

### REST API Endpoints

Runs on `API_PORT` (default: 3000).

- **GET /alerts** → List all alerts

- **POST /alerts** → Create alert

- **GET /alerts/:id** → Get specific alert

- **PUT /alerts/:id** → Update alert

- **DELETE /alerts/:id** → Delete alert

Static UI served from `/public`.

### Configuration

All settings via `.env` (see `.env.example`):

- **Environment**:

- `ENV`: dev/prod/test

- `LOG_LEVEL`: verbosity

- **Database**:

- `DATABASE_URL`: MySQL connection string

- **Exchange**:

- `EXCHANGE`: bybit/binance/etc.

- `EXCHANGE_API_KEY` / `SECRET`: for live trading

- **Telegram**:

- `TELEGRAM_BOT_TOKEN`

- `TELEGRAM_CHAT_ID`

- **Symbols & Scanning**:

- `SYMBOLS`: comma-separated list

- `TIMEFRAME`: primary (e.g., 3m)

- `HTF_TIMEFRAME`: higher (e.g., 1h)

- `SCAN_INTERVAL_MS`: scan frequency

- **Strategy Parameters**:

- `ATR_MULTIPLIER`, `RISK_REWARD_TARGET`

- `POSITION_SIZE_PERCENT`, `LEVERAGE`

- Excursion thresholds (`MAX_MAE_PCT`, etc.)

- **ML & Simulation**:

- Training thresholds and model path

- **Operational**:

- `LOCK_TYPE`: file/database

- `SCANNER_MODE`: single/periodic

- `API_PORT`

## Backtesting

`npm run backtest` runs comprehensive historical simulation:

- Configurable date range, symbols, timeframe

- Full fee/slippage modeling

- Detailed metrics: PnL, win rate, Sharpe, max drawdown, expectancy

- Trade log and equity curve output

## Contributing

1. Fork and create feature branch

2. Write clean, documented code

3. Run tests and linting:

```bash

npm test

npm run lint

npm run format

```

4. Submit PR

## License

MIT License – see [LICENSE](LICENSE)

## Acknowledgments

Powered by:

- [CCXT](https://github.com/ccxt/ccxt)

- [technicalindicators](https://github.com/anandanand84/technicalindicators)

- [Drizzle ORM](https://orm.drizzle.team/)

- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api)

- [Winston](https://github.com/winstonjs/winston)

- [Zod](https://zod.dev/)

Thank you for using Crypto Scanner — may your edges be sharp and your drawdowns shallow!
