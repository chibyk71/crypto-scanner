import { createLogger } from './lib/logger';
import { startWorker } from './lib/worker';

// Determine runtime environment (local daemon, GitHub Actions, or cPanel cron)
const RUNTIME_ENV = process.env.RUNTIME_ENV || 'server'; // Default to 'local' for backward compatibility

// Configure logging and worker options based on runtime environment
const config = {
    server: { lockType: 'file', scannerMode: 'periodic' },
    cron: { lockType: 'database', scannerMode: 'single' }
} as const;

// Select configuration based on RUNTIME_ENV, falling back to 'local'
const { lockType, scannerMode } = config[RUNTIME_ENV as keyof typeof config] || config.server;

const logger = createLogger('index');

async function main() {
    try {
        await startWorker({ lockType, scannerMode });
    } catch (err: any) {
        logger.error('Worker encountered a fatal error', { error: err.message, stack: err.stack });
        process.exit(1);
    }
}

main();
