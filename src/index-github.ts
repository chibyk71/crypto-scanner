import { startWorker } from './lib/worker-github';

startWorker().catch(err => {
    console.error('Failed to start worker:', err);
    process.exit(1);
});
