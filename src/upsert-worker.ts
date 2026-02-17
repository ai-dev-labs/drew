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

interface BatchMessage {
    type: 'batch';
    items: UpsertItem[];
}

interface ShutdownMessage {
    type: 'shutdown';
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

// Buffer + setImmediate drain pattern for maximizing batch sizes
let buffer: UpsertItem[] = [];
let flushScheduled = false;
let shuttingDown = false;

parentPort?.on('message', (msg: BatchMessage | ShutdownMessage) => {
    if (msg.type === 'batch') {
        buffer.push(...msg.items);
        scheduleFlush();
    } else if (msg.type === 'shutdown') {
        shuttingDown = true;
        scheduleFlush();
    }
});

function scheduleFlush() {
    if (!flushScheduled) {
        flushScheduled = true;
        setImmediate(flush);
    }
}

function flush() {
    flushScheduled = false;

    if (buffer.length > 0) {
        const batch = buffer;
        buffer = [];
        try {
            // Native batch upsertSync — single JS/C++ boundary crossing for entire batch
            collection.upsertSync(batch);
            parentPort?.postMessage({ type: 'done', count: batch.length } as DoneMessage);
        } catch (err: any) {
            if (isZVecError(err)) {
                parentPort?.postMessage({ type: 'error', message: err.message, count: batch.length } as ErrorMessage);
            } else {
                parentPort?.postMessage({ type: 'error', message: err.message, count: batch.length } as ErrorMessage);
                // Non-zvec errors are unexpected; still continue to drain remaining items
            }
        }
    }

    // After upsertSync returns, queued messages were processed by the event loop
    // (poll phase) before this setImmediate (check phase). If more items arrived
    // during the upsert, they're now in the buffer.
    if (buffer.length > 0) {
        scheduleFlush();
    } else if (shuttingDown) {
        try {
            collection.closeSync();
        } catch {
            // Ignore close errors
        }
        process.exit(0);
    }
}
