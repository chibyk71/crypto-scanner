
# Crypto Scanner

A Node.js-based cryptocurrency trading bot that scans markets on Gate.io (or other exchanges via `ccxt`), generates trading signals using technical indicators, and sends alerts to Telegram. It uses a MySQL database for persistent storage of alerts and locks, managed with `drizzle-orm`. The bot supports periodic market scans (e.g., every 5 minutes) via cron jobs on cPanel or other platforms.

## Features
- **Market Scanning**: Scans trading pairs (e.g., BTC/USDT, ETH/USDT) for buy/sell signals using `technicalindicators`.
- **Exchange Integration**: Connects to Gate.io via `ccxt` for real-time market data.
- **Telegram Alerts**: Sends signals and heartbeats to a Telegram chat/channel using `node-telegram-bot-api`.
- **Database**: Stores alerts and locks in MySQL with `drizzle-orm`.
- **Deployment**: Supports cPanel (cron jobs), GitHub Actions, Oracle Cloud, or Render.

## Prerequisites
- **Node.js**: Version >= 10.
- **Git**: For cloning the repository (or ZIP download).
- **Exchange API Keys**: From Gate.io.
- **Telegram Bot**: Created via BotFather.
- **MySQL Database**: Set up via cPanel's MySQL Databases.
- **cPanel Hosting**: With Node.js support (e.g., A2 Hosting, $2.99/month).

## Installation
1. **Clone or Download the Repository**:
   - Download ZIP from `https://github.com/chibyk71/crypto-scanner/archive/main.zip`.
   - Extract to `/home/username/crypto-scanner` in cPanel's **File Manager**.

2. **Install Dependencies**:
   - In cPanel > **Setup Node.js App**, select your app.
   - Click **Run NPM Install**.

3. **Set Up MySQL Database**:
   - In cPanel > **MySQL Databases**:
     - Create a database (e.g., `username_crypto_scanner`).
     - Create a user (e.g., `username_crypto_user`) with a password.
     - Assign the user to the database with **ALL PRIVILEGES**.
   - Note the connection details: `mysql://username_crypto_user:password@localhost:3306/username_crypto_scanner`.

4. **Set Up Environment Variables**:
   - In **File Manager**, create/edit `.env` in `/home/username/crypto-scanner`.
   - Example:
     ```env
     ENV=prod
     LOG_LEVEL=INFO
     HEARTBEAT_INTERVAL=12
     SYMBOLS=BTC/USDT,ETH/USDT
     EXCHANGE=gate
     EXCHANGE_API_KEY=your-key
     EXCHANGE_API_SECRET=your-secret
     TELEGRAM_BOT_TOKEN=your-token
     TELEGRAM_CHAT_ID=your-chat-id
     DATABASE_URL=mysql://username_crypto_user:password@localhost:3306/username_crypto_scanner
     ```
   - Set `.env` permissions to 600.

5. **Run Migrations**:
   - In **Setup Node.js App**, set **Custom Startup Command**:
     ```bash
     npm run db:generate && npm run db:migrate
     ```
   - Click **Restart** to apply migrations (creates tables).

6. **Build the Project**:
   - In **Setup Node.js App**, set **Custom Startup Command**:
     ```bash
     npm run build
     ```
   - Click **Restart**.

7. **Test Locally**:
   - Set **Custom Startup Command**:
     ```bash
     npm run start:github
     ```
   - Check **Application Logs** for "MySQL database initialized successfully".
   - Verify Telegram heartbeats (hourly) and alerts.

## Environment Variables
See `.env.example` for a template. Key variables:
- `ENV`: `prod` for production, `dev` for development.
- `LOG_LEVEL`: `INFO` or `DEBUG`.
- `HEARTBEAT_INTERVAL`: Heartbeats every N scans (e.g., `12` for hourly at 5-min cron).
- `SYMBOLS`: Comma-separated trading pairs (e.g., `BTC/USDT,ETH/USDT`).
- `EXCHANGE`: `gate` for Gate.io.
- `DATABASE_URL`: MySQL connection string (e.g., `mysql://user:pass@localhost:3306/db`).

**Example**:
```env
ENV=prod
LOG_LEVEL=INFO
HEARTBEAT_INTERVAL=12
SYMBOLS=BTC/USDT,ETH/USDT
EXCHANGE=gate
EXCHANGE_API_KEY=your-key
EXCHANGE_API_SECRET=your-secret
TELEGRAM_BOT_TOKEN=your-token
TELEGRAM_CHAT_ID=your-chat-id
DATABASE_URL=mysql://username_crypto_user:password@localhost:3306/username_crypto_scanner
```

## Deployment on cPanel (Cron Job)
1. **Choose a Provider**: A2 Hosting ($2.99/month, Node.js support).
2. **Upload Code**:
   - In **File Manager**, upload ZIP or files to `/home/username/crypto-scanner`.
   - Extract ZIP and delete it.
3. **Set Up Environment**:
   - Create `.env` (see above).
   - Set permissions to 600.
4. **Set Up MySQL**:
   - Create database and user in **MySQL Databases**.
   - Update `.env` with connection string.
5. **Run Migrations**:
   - In **Setup Node.js App**, run:
     ```bash
     npm run db:migrate
     ```
6. **Configure Cron Job**:
   - In cPanel > **Cron Jobs**:
     - **Common Settings**: “Every 5 minutes” (`*/5 * * * *`).
     - **Command**:
       ```bash
       cd /home/username/crypto-scanner && node dist/index-github.js >> /home/username/crypto-scanner/logs/cron.log 2>&1
       ```
   - Create `logs/` folder (permissions 755).
7. **Monitor**:
   - Check `logs/cron.log` in **File Manager**.
   - Verify Telegram heartbeats and alerts.
   - Set cron email in **Cron Jobs**.

## Alternative Deployments
- **GitHub Actions**: Uses `index-github.ts` for scheduled scans (free, 5-min gaps).
- **Oracle Cloud**: Free tier (4 GB RAM), uses `scanner.ts` with PM2.
- **Render**: $7.30/month, uses `scanner.ts` with persistent disk.

## Troubleshooting
- **NetworkError**: If `Failed to initialize exchange`:
  - Verify `EXCHANGE_API_KEY`/`EXCHANGE_API_SECRET` in `.env`.
  - Contact support to unblock Gate.io API (port 443).
- **Database Issues**: Ensure MySQL credentials are correct in `.env`. Check tables in **phpMyAdmin**.
- **Cron Failures**: Check `logs/cron.log` or cron email output.

## Contributing
- Fork the repository.
- Create a feature branch: `git checkout -b feature-name`.
- Commit changes: `git commit -m "Add feature"`.
- Push: `git push origin feature-name`.
- Open a pull request.

## License
MIT License. See [LICENSE](LICENSE).
