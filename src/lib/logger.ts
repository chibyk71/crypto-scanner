import { createLogger as winstonCreateLogger, format, transports } from 'winston';
import { config } from './config/settings';
import * as path from 'path';
import * as fs from 'fs';

// Ensure logs directory exists
const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Creates a Winston logger instance with console and file transports.
 * - Configurable log level via LOG_LEVEL env (defaults to 'info').
 * - Console logs show in cPanel logs, file logs go to logs/app.log.
 * - Used across modules for consistent logging.
 * @param label - Logger label (e.g., 'db', 'scanner').
 */
export function createLogger(label: string) {
    const logLevel = (config.log_level || 'info').toLowerCase();

    return winstonCreateLogger({
        level: logLevel,
        format: format.combine(
            format.label({ label }),
            format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            format.errors({ stack: true }), // Ensure stack traces are captured
            format.splat(),                 // Allow printf-style %s replacements
            format.printf(({ level, message, label, timestamp, stack }) => {
                return stack
                    ? `${timestamp} [${label}] ${level.toUpperCase()}: ${message}\n${stack}`
                    : `${timestamp} [${label}] ${level.toUpperCase()}: ${message}`;
            })
        ),
        transports: [
            new transports.Console(),
            new transports.File({ filename: path.join(logDir, 'app.log') }),
        ],
    });
}
