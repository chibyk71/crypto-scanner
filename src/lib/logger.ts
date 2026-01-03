// src/lib/logger.ts
// =============================================================================
// CENTRALIZED WINSTON LOGGER FACTORY – PRODUCTION-GRADE & HIGHLY CONFIGURABLE
// Used by EVERY module in the bot: scanner, strategy, exchange, ML, telegram, etc.
// Features:
//   • Colorized console output (dev) + structured file logs (prod)
//   • JSON + human-readable dual format
//   • Stack traces preserved
//   • Per-module labeling (e.g., [Strategy], [MLService])
//   • Auto-creates logs/ directory
//   • Respects LOG_LEVEL from config (debug in dev, info/warn in prod)
// =============================================================================

import { createLogger as winstonCreateLogger, format, transports } from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { config } from './config/settings';

// Ensure logs directory exists (critical for Docker/K8s environments)
const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Default log level fallback
const DEFAULT_LOG_LEVEL = 'info';

/**
 * Creates a fully configured Winston logger instance.
 * One logger per module (via label) → easy filtering and debugging.
 *
 * @param label - Module name (e.g., 'Strategy', 'MLService', 'Scanner')
 * @returns Configured Winston Logger instance
 */
export function createLogger(label: string) {
    // Pull log level from config first, then env var, then default
    const envLevel = config.log_level;
    const logLevel = (envLevel || DEFAULT_LOG_LEVEL).toLowerCase();

    // Human-readable format for console (dev-friendly)
    const consoleFormat = format.combine(
        format.label({ label: `[${label}]` }),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        format.colorize({ all: true }),
        format.errors({ stack: true }),
        format.printf(({ level, message, label, timestamp, stack, ...meta }) => {
            let logLine = `${timestamp} ${label} ${level}: ${message}`;

            // Append structured metadata if present
            if (Object.keys(meta).length > 0) {
                const metaStr = JSON.stringify(meta, null, 2);
                logLine += `\n${metaStr}`;
            }

            // Append stack trace if error
            if (stack) {
                logLine += `\n${stack}`;
            }

            return logLine;
        })
    );

    // JSON format for file (ideal for log aggregation: ELK, Datadog, etc.)
    const fileFormat = format.combine(
        format.label({ label }),
        format.timestamp(),
        format.errors({ stack: true }),
        format.json()
    );

    return winstonCreateLogger({
        level: logLevel,
        format: format.combine(
            format.label({ label }),
            format.timestamp(),
            format.errors({ stack: true })
        ),
        transports: [
            // Console: colored, human-readable
            new transports.Console({
                format: consoleFormat,
                stderrLevels: ['error', 'warn', 'debug'],
            }),

            // File: daily rotating + JSON (perfect for production)
            new transports.File({
                filename: path.join(LOG_DIR, 'app.log'),
                level: 'info',
                format: fileFormat,
                maxsize: 50 * 1024 * 1024,    // 50 MB
                maxFiles: 10,
                tailable: true,
            }),

            // Separate error log (only error/warn)
            new transports.File({
                filename: path.join(LOG_DIR, 'debug.log'),
                level: "debug",
                format: fileFormat,
                maxsize: 20 * 1024 * 1024,
                maxFiles: 5,
            }),

            // Separate error log (only error/warn)
            new transports.File({
                filename: path.join(LOG_DIR, 'error.log'),
                level: 'error',
                format: fileFormat,
                maxsize: 20 * 1024 * 1024,
                maxFiles: 5,
            }),
        ],

        // Do not exit on unhandled exceptions – we want the bot to stay alive
        exitOnError: false,
    });
}

/**
 * Global logger for bootstrapping (before config is loaded)
 * Used only in worker.ts during startup
 */
export const bootstrapLogger = createLogger('Bootstrap');
