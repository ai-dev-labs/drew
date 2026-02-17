import { parentPort, workerData } from 'worker_threads';

const {
    ZVecOpen,
    ZVecInitialize,
    isZVecError,
} = require('@zvec/zvec');

interface UpsertItem {
    id: string;
    vectors: { embedding: number[] };
    fields: Record<string, string>;
}

interface UpsertMessage {
    type: 'batch';
    items: UpsertItem[];
}

interface DoneMessage {
    type: 'done';
    count: number;
}

interface ErrorMessage {
    type: 'error';
    message: string;
    count: number;
}

// Initialize zvec and open collection from worker context
ZVecInitialize({ logLevel: 3 }); // ERROR only
const collectionPath: string = workerData.collectionPath;
let collection: any;

try {
    collection = ZVecOpen(collectionPath);
} catch (err: any) {
    parentPort?.postMessage({ type: 'error', message: `Failed to open collection: ${err.message}`, count: 0 } as ErrorMessage);
    process.exit(1);
}

parentPort?.on('message', (msg: UpsertMessage | { type: 'shutdown' }) => {
    if (msg.type === 'shutdown') {
        try {
            collection.closeSync();
        } catch {
            // Ignore close errors
        }
        process.exit(0);
    }

    if (msg.type === 'batch') {
        let completed = 0;
        for (const item of msg.items) {
            try {
                collection.upsertSync({
                    id: item.id,
                    vectors: item.vectors,
                    fields: item.fields,
                });
                completed++;
            } catch (err: any) {
                if (isZVecError(err)) {
                    // Log and skip failed item, continue with rest
                    // Error is non-fatal; partial index is acceptable
                } else {
                    throw err;
                }
            }
        }
        parentPort?.postMessage({ type: 'done', count: completed } as DoneMessage);
    }
});
