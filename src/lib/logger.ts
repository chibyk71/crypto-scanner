import { createLogger as winstonCreateLogger, format, transports } from 'winston';
import { config } from './config/settings';

/**
 * Creates a Winston logger instance with console and file transports.
 * - Supports configurable log levels (e.g., 'INFO', 'DEBUG') via LOG_LEVEL env.
 * - Logs to console (for cPanel Setup Node.js App logs) and file (logs/app.log).
 * - Used in db/index.ts, scanner-github.ts, and other modules for consistent logging.
 * @param label - The label for the logger (e.g., 'db', 'scanner').
 * @returns A Winston logger instance.
 */
export function createLogger(label: string) {
    const logLevel = config.log_level || 'info'; // Default to 'info' if LOG_LEVEL is unset.

    return winstonCreateLogger({
        level: logLevel.toLowerCase(), // Normalize to lowercase for Winston.
        format: format.combine(
            format.label({ label }), // Add module label (e.g., '[db]').
            format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), // Add timestamp.
            format.printf(({ level, message, label, timestamp }) => {
                return `${timestamp} [${label}] ${level.toUpperCase()}: ${message}`;
            }),
        ),
        transports: [
            new transports.Console(), // Logs to console (visible in cPanel Setup Node.js App logs).
            new transports.File({ filename: 'logs/app.log' }), // Logs to /home/username/crypto-scanner/logs/app.log.
        ],
    });
}
