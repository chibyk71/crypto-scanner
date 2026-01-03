// src/lib/api.ts
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { dbService } from './db';
import { TelegramBotController } from './services/telegramBotController';
import { ExchangeService } from './services/exchange';
import { MLService } from './services/mlService';
import { config } from './config/settings';
import { createLogger } from './logger';

const logger = createLogger('WebhookServer');

const WEBHOOK_PATH = '/telegram/webhook';   // ← configure this in Telegram @BotFather or via setWebhook call

/**
 * Starts a minimal HTTP server that:
 *   - Accepts Telegram webhook POST updates and forwards them to the bot instance
 *   - Serves a simple health check at root (/)
 *   - Does NOT expose any alert CRUD endpoints anymore
 *   - Initializes DB + core services only for dependency injection into TelegramBotController
 */
export async function startApiServer() {
    // 1. Ensure DB is ready (TelegramBotController needs it for alert CRUD)
    await dbService.initialize();
    logger.info('Database connection established for webhook server');

    // 2. Instantiate dependencies needed by TelegramBotController
    const exchange = new ExchangeService();
    await exchange.initialize();   // needed for symbol list, positions, etc. in /positions, /excursions, etc.

    const mlService = new MLService();

    // 3. Create Telegram bot instance (webhook mode – no polling)
    const botController = new TelegramBotController(exchange, mlService);
    logger.info('TelegramBotController created (webhook mode)');

    // Optional: set webhook automatically on startup (only do once or on deploy)
    // if (config.env === 'prod' && config.telegram.webhookUrl) {
    //     await botController.setupWebhook(config.telegram.webhookUrl);
    //     logger.info(`Webhook auto-configured to ${config.telegram.webhookUrl}`);
    // }

    // 4. Minimal HTTP server
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const method = req.method;
        const url = req.url || '/';
        logger.debug(`Incoming ${method} ${url}`);

        try {
            // ─── Health check ───────────────────────────────────────
            if (method === 'GET' && url === '/') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    uptime: process.uptime(),
                    env: config.env,
                    timestamp: new Date().toISOString(),
                }));
                return;
            }

            // ─── Telegram webhook ───────────────────────────────────
            if (method === 'POST' && url === WEBHOOK_PATH) {
                // Optional: secret token protection (recommended)
                // const secret = req.headers['x-telegram-bot-api-secret-token'];
                // if (secret !== config.telegram.secretToken) {
                //     res.writeHead(403);
                //     res.end('Forbidden');
                //     return;
                // }

                // Read JSON body (Telegram updates are small)
                const body = await getJsonBody(req);

                // Forward to bot instance
                // await botController.bot.processUpdate(body);
                console.log(body);


                // Telegram requires 200 OK (even on internal error)
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            // 404 everything else
            res.writeHead(404);
            res.end('Not found');

        } catch (err: any) {
            logger.error('Request failed', {
                method,
                url,
                error: err.message,
                stack: err.stack?.slice(0, 300),
            });
            res.writeHead(500);
            res.end('Internal error');
        }
    });

    // ─── Body parser helper ─────────────────────────────────────
    async function getJsonBody(req: IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                try {
                    const str = Buffer.concat(chunks).toString('utf-8');
                    resolve(str ? JSON.parse(str) : {});
                } catch (e) {
                    reject(e);
                }
            });
            req.on('error', reject);
        });
    }

    // ─── Start listening ────────────────────────────────────────
    const port = Number(process.env.API_PORT) || 3000;

    server.listen(port, '0.0.0.0', () => {
        logger.info(`Webhook server listening on port ${port}`);
        logger.info(`Telegram webhook path: ${WEBHOOK_PATH}`);
        logger.info('Reminder: set webhook via Telegram API if not already done:');
        logger.info(`  → https://api.telegram.org/bot<token>/setWebhook?url=https://your-domain.com${WEBHOOK_PATH}`);
    });

    // ─── Graceful shutdown ──────────────────────────────────────
    const shutdown = async (signal: string) => {
        logger.info(`${signal} received – shutting down webhook server`);
        server.close();
        botController.stop();
        await dbService.close();
        await exchange.stopAll();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    return server; // optional
}
