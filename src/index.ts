import { logger, startWorker } from "./lib/worker";

startWorker().catch((err) => {
    logger.error('Worker encountered a fatal error', { error: err });
    process.exit(1); // Exit on unhandled errors
});
