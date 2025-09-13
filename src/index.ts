import { createLogger } from "./lib/logger";
import { startWorker } from "./lib/worker";

const logger = createLogger('index');

startWorker().catch((err) => {
    logger.error('Worker encountered a fatal error', { error: err, stack: err.stack });
    process.exit(1); // Exit on unhandled errors
});
