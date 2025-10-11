import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { z } from 'zod';
import { dbService } from './db';
import { createLogger } from './logger';
import { createReadStream } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { alert as alertTable, type NewAlert } from './db/schema';
import type { Condition } from '../types';

/**
 * Logger instance for API operations, used to log requests, errors, and server events.
 * Configured via createLogger from logger.ts.
 * @constant
 */
const logger = createLogger('API');

/**
 * Path to the public directory for serving static files (e.g., index.html for the UI).
 * @constant
 */
const PUBLIC_DIR = join(__dirname, '../../public');

/**
 * Port for the API server, defaults to 3000 if not specified in environment variables.
 * @constant
 */
const API_PORT = Number(process.env.API_PORT) || 3000;

/**
 * Zod schema for validating individual alert conditions.
 * Aligns with the Condition type in db/schema.ts.
 * @constant
 */
const ConditionSchema = z.object({
    indicator: z.enum(['price', 'volume', 'rsi', 'trend'], {
        message: 'Indicator must be one of: price, volume, rsi, trend',
    }),
    operator: z.enum(['>', '<', '>=', '<=', 'in', 'crosses_above', 'crosses_below'], {
        message: 'Operator must be one of: >, <, >=, <=, in, crosses_above, crosses_below',
    }),
    target: z.union([z.number(), z.tuple([z.number(), z.number()])], {
        message: 'Target must be a number or an array of exactly two numbers',
    }),
});

/**
 * Zod schema for validating new alert creation (POST /alerts).
 * Ensures required fields and correct data types for alert creation.
 * @constant
 */
const AlertSchema = z.object({
    symbol: z.string().min(1, 'Symbol is required'),
    conditions: z.array(ConditionSchema).min(1, 'At least one condition is required'),
    timeframe: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
    status: z.enum(['active', 'triggered', 'canceled']).default('active'),
    note: z.string().max(255).optional(),
    lastAlertAt: z.number().optional(),
});

/**
 * Zod schema for validating alert updates (PUT /alerts/:id).
 * Allows partial updates to status, conditions, timeframe, and note.
 * @constant
 */
const UpdateSchema = z.object({
    status: z.enum(['triggered', 'canceled'], {
        message: 'Status must be one of: triggered, canceled',
    }),
    conditions: z.array(ConditionSchema).optional(),
    timeframe: z.enum(['15m', '1h', '4h', '1d']).optional(),
    note: z.string().max(255).optional(),
});

/**
 * Reads and parses the request body as JSON.
 * Collects chunks from the request stream and parses them into a JSON object.
 * @param req - The incoming HTTP request containing the JSON payload.
 * @returns {Promise<any>} A promise resolving to the parsed JSON body, or an empty object if no body.
 * @throws {Error} If JSON parsing fails, rejected with the parsing error.
 * @example
 * // Example request body: {"symbol":"SOL/USDT","conditions":[{"indicator":"price","operator":">","target":3.54}]}
 * const body = await getRequestBody(req);
 */
async function getRequestBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Sends an HTTP response with JSON content.
 * Sets the appropriate status code and Content-Type header.
 * @param res - The HTTP response object to write to.
 * @param statusCode - The HTTP status code (e.g., 200 for success, 400 for bad request).
 * @param data - The response data to serialize as JSON.
 * @example
 * // Send a successful response
 * sendResponse(res, 200, { id: 1, symbol: 'SOL/USDT' });
 */
function sendResponse(res: ServerResponse, statusCode: number, data: any) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * Starts the HTTP API server, handling requests for alerts and static files.
 * Initializes the database connection and sets up graceful shutdown.
 * Serves static files from the public directory (e.g., index.html for the UI).
 * Provides endpoints for creating, reading, updating, and deleting alerts.
 * @returns {Promise<void>} A promise that resolves when the server starts listening.
 * @throws {Error} If database initialization or server startup fails, logged via logger.
 * @example
 * // Start the server
 * await startApiServer();
 */
export async function startApiServer() {
    /**
     * Initializes the database connection before starting the server.
     * Ensures dbService is ready to handle queries.
     */
    await dbService.initialize();

    /**
     * Creates an HTTP server to handle incoming requests.
     * Routes requests to appropriate handlers based on method and path.
     */
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const { method, url } = req;
        const parsedUrl = parse(url || '', true);
        const path = parsedUrl.pathname;

        logger.info(`Received ${method} request for ${path}`);

        try {
            /**
             * Serves the static index.html file for the root path.
             * Provides the UI for managing alerts.
             */
            if (method === 'GET' && path === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                createReadStream(join(PUBLIC_DIR, 'index.html')).pipe(res);
                return;
            }

            /**
             * Retrieves all active alerts from the database.
             * Returns a JSON array of alerts with parsed conditions.
             */
            if (method === 'GET' && path === '/alerts') {
                const alerts = await dbService.getActiveAlerts();
                sendResponse(res, 200, alerts);
                return;
            }

            /**
             * Retrieves active alerts for a specific symbol.
             * Expects path format: /alerts/:symbol (e.g., /alerts/SOL/USDT).
             */
            if (method === 'GET' && path?.startsWith('/alerts/')) {
                const symbol = path.split('/')[2];
                if (!symbol) {
                    sendResponse(res, 400, { error: 'Symbol is required' });
                    return;
                }
                const alerts = await dbService.getAlertsBySymbol(symbol);
                sendResponse(res, 200, alerts);
                return;
            }

            /**
             * Creates a new alert in the database.
             * Validates the request body against AlertSchema and stores conditions as JSON.
             */
            if (method === 'POST' && path === '/alerts') {
                const body = await getRequestBody(req);
                const parsed = AlertSchema.safeParse(body);
                if (!parsed.success) {
                    sendResponse(res, 400, { error: parsed.error.flatten() });
                    return;
                }
                /**
                 * Maps parsed data to NewAlert, ensuring conditions match Condition[].
                 * Conditions are already validated as { indicator, operator, target }[].
                 */
                const alertData: NewAlert = {
                    symbol: parsed.data.symbol,
                    conditions: parsed.data.conditions as Condition[], // Type assertion since schema matches
                    timeframe: parsed.data.timeframe,
                    status: parsed.data.status,
                    note: parsed.data.note,
                    lastAlertAt: parsed.data.lastAlertAt,
                };
                const alertId = await dbService.createAlert(alertData);
                sendResponse(res, 201, { id: alertId, ...alertData });
                return;
            }

            /**
             * Updates an existing alert by ID.
             * Validates the request body against UpdateSchema.
             * Retains existing conditions if not provided in the request.
             */
            if (method === 'PUT' && path?.startsWith('/alerts/')) {
                const id = parseInt(path.split('/')[2], 10);
                if (isNaN(id)) {
                    sendResponse(res, 400, { error: 'Invalid alert ID' });
                    return;
                }
                const body = await getRequestBody(req);
                const parsed = UpdateSchema.safeParse(body);
                if (!parsed.success) {
                    sendResponse(res, 400, { error: parsed.error.flatten() });
                    return;
                }
                const alert = await dbService.getAlertsById(id);
                if (!alert) {
                    sendResponse(res, 404, { error: `Alert with ID ${id} not found` });
                    return;
                }
                /**
                 * Uses new conditions if provided; otherwise, retains existing conditions.
                 */
                const conditionsToUpdate = parsed.data.conditions ? (parsed.data.conditions as Condition[]) : alert.conditions;
                const updated = await dbService.db
                    .update(alertTable)
                    .set({
                        status: parsed.data.status,
                        conditions: conditionsToUpdate,
                        timeframe: parsed.data.timeframe ?? alert.timeframe,
                        note: parsed.data.note ?? alert.note,
                    })
                    .where(eq(alertTable.id, id))
                    .execute();
                if (updated[0].affectedRows === 0) {
                    sendResponse(res, 404, { error: `Alert with ID ${id} not found` });
                    return;
                }
                sendResponse(res, 200, { id, ...parsed.data, conditions: conditionsToUpdate });
                return;
            }

            /**
             * Deletes an alert by ID.
             * Removes the alert from the database and returns a 204 status.
             */
            if (method === 'DELETE' && path?.startsWith('/alerts/')) {
                const id = parseInt(path.split('/')[2], 10);
                if (isNaN(id)) {
                    sendResponse(res, 400, { error: 'Invalid alert ID' });
                    return;
                }
                await dbService.deleteAlert(id);
                sendResponse(res, 204, {});
                return;
            }

            /**
             * Returns a 404 response for unknown routes.
             */
            sendResponse(res, 404, { error: 'Route not found' });
        } catch (err: any) {
            logger.error(`API error on ${method} ${path}: ${err.message}`);
            sendResponse(res, 500, { error: 'Internal server error' });
        }
    });

    /**
     * Starts the HTTP server on the configured port.
     * Logs startup and listens for SIGTERM to gracefully shut down.
     */
    server.listen(API_PORT, () => {
        logger.info(`API server running on port ${API_PORT}`);
    });

    /**
     * Handles graceful shutdown on SIGTERM.
     * Closes the server and database connection before exiting.
     */
    process.on('SIGTERM', async () => {
        logger.info('Shutting down API server');
        server.close();
        await dbService.close();
        process.exit(0);
    });
}