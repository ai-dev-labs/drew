import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs-extra';
import * as cliProgress from 'cli-progress';
import { Worker } from 'worker_threads';
import { CodeGraphNode, Requirement, SpecMap } from './engine';
import { EmbeddingProvider } from './embeddings';

const {
    ZVecCollectionSchema,
    ZVecCreateAndOpen,
    ZVecOpen,
    ZVecDataType,
    ZVecIndexType,
    ZVecMetricType,
    ZVecInitialize,
    isZVecError,
} = require('@zvec/zvec');

export interface SearchResult {
    id: string;
    type: 'node' | 'spec';
    score: number;
    data: CodeGraphNode | Requirement;
    linkedNodes?: CodeGraphNode[];
}

export interface IndexResult {
    nodes: number;
    specs: number;
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
}

interface IndexableItem {
    text: string;
    id: string;
    fields: Record<string, string>;
    checksum: string;
}

interface IndexDiff {
    toEmbed: IndexableItem[];
    toDelete: string[];
    unchanged: number;
    added: number;
    updated: number;
}

function nodeSearchableText(node: CodeGraphNode): string {
    const parts = [`${node.name} (${node.kind}) in ${node.path}`];
    if (node.summary) parts.push(node.summary);
    return parts.join('\n');
}

function specSearchableText(spec: Requirement): string {
    const parts = [`${spec.id}: ${spec.description}`];
    if (spec.acceptance_criteria.length > 0) {
        parts.push('Acceptance Criteria:');
        for (const c of spec.acceptance_criteria) {
            parts.push(`- ${c}`);
        }
    }
    if (spec.node_ids.length > 0) {
        parts.push(`Linked nodes: ${spec.node_ids.join(', ')}`);
    }
    return parts.join('\n');
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

/** Auto-tune batch size based on available memory. Clamps to [16, 128], but never exceeds totalItems. */
export function determineBatchSize(totalItems: number, freeMem?: number): number {
    const free = freeMem ?? os.freemem();
    // ~2MB per item in batch (tensors + intermediate)
    const memoryBudget = Math.floor(free * 0.3);
    const maxByMemory = Math.floor(memoryBudget / (2 * 1024 * 1024));
    const clamped = Math.max(16, Math.min(128, maxByMemory));
    return Math.min(clamped, totalItems);
}

/** Encode a Drew ID into a fixed-length zvec-safe document ID */
function encodeId(id: string): string {
    return crypto.createHash('sha256').update(id).digest('hex');
}

function buildSchema() {
    return new ZVecCollectionSchema({
        name: 'drew-vectors',
        vectors: {
            name: 'embedding',
            dataType: ZVecDataType.VECTOR_FP32,
            dimension: 512,
            indexParams: {
                indexType: ZVecIndexType.HNSW,
                metricType: ZVecMetricType.COSINE,
            }
        },
        fields: [
            { name: 'type', dataType: ZVecDataType.STRING,
              indexParams: { indexType: ZVecIndexType.INVERT } },
            { name: 'original_id', dataType: ZVecDataType.STRING,
              indexParams: { indexType: ZVecIndexType.INVERT } },
            { name: 'name', dataType: ZVecDataType.STRING },
            { name: 'content', dataType: ZVecDataType.STRING },
            { name: 'path', dataType: ZVecDataType.STRING, nullable: true },
            { name: 'kind', dataType: ZVecDataType.STRING, nullable: true },
            { name: 'node_ids', dataType: ZVecDataType.STRING, nullable: true },
        ]
    });
}

export class DrewVectorStore {
    private collection: any = null;
    private collectionPath: string;

    constructor(
        private rootPath: string,
        private embedder: EmbeddingProvider,
    ) {
        this.collectionPath = path.join(rootPath, '.drew', '.data');
    }

    async create(reindex: boolean): Promise<void> {
        ZVecInitialize({ logLevel: 3 }); // ERROR only

        if (reindex) {
            if (await fs.pathExists(this.collectionPath)) {
                await fs.remove(this.collectionPath);
            }
            // Also remove the indexed IDs sidecar file for a clean rebuild
            const idsPath = this.indexedIdsPath();
            if (await fs.pathExists(idsPath)) {
                await fs.remove(idsPath);
            }
        }

        if (await fs.pathExists(this.collectionPath)) {
            // Open existing
            this.collection = ZVecOpen(this.collectionPath);
        } else {
            await fs.ensureDir(path.dirname(this.collectionPath));
            this.collection = ZVecCreateAndOpen(this.collectionPath, buildSchema());
        }
    }

    async open(): Promise<boolean> {
        if (!await fs.pathExists(this.collectionPath)) {
            return false;
        }
        ZVecInitialize({ logLevel: 3 });
        this.collection = ZVecOpen(this.collectionPath);
        return true;
    }

    async indexAll(specMap: SpecMap, concurrency?: number): Promise<IndexResult> {
        if (!this.collection) throw new Error('Collection not open');

        const nodes = Object.values(specMap.nodes);
        const specs = Object.values(specMap.specifications ?? {});
        const total = nodes.length + specs.length;

        if (total === 0) {
            this.saveIndexedIds(new Set());
            return { nodes: 0, specs: 0, added: 0, updated: 0, removed: 0, unchanged: 0 };
        }

        // Prepare items with their text, fields, and checksum
        const items: IndexableItem[] = [];

        for (const node of nodes) {
            items.push({
                text: nodeSearchableText(node),
                id: encodeId(node.id),
                fields: {
                    type: 'node',
                    original_id: node.id,
                    name: node.name,
                    content: JSON.stringify(node),
                    path: node.path,
                    kind: node.kind,
                    node_ids: '',
                },
                checksum: node.checksum,
            });
        }

        for (const spec of specs) {
            items.push({
                text: specSearchableText(spec),
                id: encodeId(spec.id),
                fields: {
                    type: 'spec',
                    original_id: spec.id,
                    name: spec.id,
                    content: JSON.stringify(spec),
                    path: '',
                    kind: '',
                    node_ids: JSON.stringify(spec.node_ids),
                },
                checksum: spec.checksum,
            });
        }

        // ── Incremental Diff ──
        const diff = this.diffItems(items);
        const workItems = diff.toEmbed.length + diff.toDelete.length;

        if (workItems === 0) {
            // Save current IDs (no changes, but keep sidecar in sync)
            this.saveIndexedIds(new Set(items.map(i => i.id)));
            return {
                nodes: nodes.length,
                specs: specs.length,
                added: 0,
                updated: 0,
                removed: 0,
                unchanged: diff.unchanged,
            };
        }

        const progress = new cliProgress.SingleBar({
            format: 'Indexing | {bar} | {percentage}% | {value}/{total} Documents',
        }, cliProgress.Presets.shades_classic);
        progress.start(workItems, 0);

        // ── Phase 1: Batch Embedding (only changed/new items) ──
        const batchSize = determineBatchSize(diff.toEmbed.length);
        const embedded: { item: IndexableItem; embedding: number[] }[] = [];

        for (let i = 0; i < diff.toEmbed.length; i += batchSize) {
            const batch = diff.toEmbed.slice(i, i + batchSize);
            const texts = batch.map(b => b.text);

            let embeddings: number[][];
            if (this.embedder.embedBatch) {
                let currentBatchSize = texts.length;
                while (true) {
                    try {
                        embeddings = await this.embedder.embedBatch(texts.slice(0, currentBatchSize));
                        if (currentBatchSize < texts.length) {
                            const rest = await this.embedBatchWithRetry(
                                texts.slice(currentBatchSize),
                                Math.max(16, Math.floor(currentBatchSize / 2)),
                            );
                            embeddings = embeddings.concat(rest);
                        }
                        break;
                    } catch (err: any) {
                        if (currentBatchSize <= 16) throw err;
                        currentBatchSize = Math.max(16, Math.floor(currentBatchSize / 2));
                    }
                }
            } else {
                embeddings = await Promise.all(texts.map(t => this.embedder.embed(t)));
            }

            for (let j = 0; j < batch.length; j++) {
                embedded.push({ item: batch[j], embedding: embeddings[j] });
            }
            progress.increment(batch.length);
        }

        // ── Phase 2: Worker Thread Upserts (only changed/new items) ──
        this.collection.closeSync();
        this.collection = null;

        const upsertSuccess = await this.upsertViaWorkers(embedded, 1);

        this.collection = ZVecOpen(this.collectionPath);

        if (!upsertSuccess) {
            for (const { item, embedding } of embedded) {
                this.collection.upsertSync({
                    id: item.id,
                    vectors: { embedding },
                    fields: item.fields,
                });
            }
        }

        // ── Phase 3: Delete stale entries ──
        for (const staleId of diff.toDelete) {
            try {
                this.collection.deleteSync(staleId);
            } catch {
                // Non-fatal: skip entries that can't be deleted
            }
            progress.increment(1);
        }

        progress.stop();

        this.collection.optimizeSync();

        // Save current set of indexed IDs
        this.saveIndexedIds(new Set(items.map(i => i.id)));

        return {
            nodes: nodes.length,
            specs: specs.length,
            added: diff.added,
            updated: diff.updated,
            removed: diff.toDelete.length,
            unchanged: diff.unchanged,
        };
    }

    private indexedIdsPath(): string {
        return path.join(this.rootPath, '.drew', '.index-ids.json');
    }

    private loadIndexedIds(): Set<string> {
        const p = this.indexedIdsPath();
        try {
            if (fs.pathExistsSync(p)) {
                return new Set(fs.readJsonSync(p) as string[]);
            }
        } catch {
            // Corrupt or unreadable — treat as first run
        }
        return new Set();
    }

    private saveIndexedIds(ids: Set<string>): void {
        try {
            fs.writeJsonSync(this.indexedIdsPath(), [...ids]);
        } catch {
            // Non-fatal: stale detection will be skipped on next run
        }
    }

    private diffItems(items: IndexableItem[]): IndexDiff {
        const previousIds = this.loadIndexedIds();
        const currentIds = new Set(items.map(i => i.id));

        // Batch fetch all current IDs from zvec
        const encodedIds = items.map(i => i.id);
        let existing: Record<string, any> = {};
        try {
            existing = this.collection.fetchSync(encodedIds);
        } catch {
            // fetchSync failed — fall back to full re-index (treat all as new)
            return {
                toEmbed: items,
                toDelete: [],
                unchanged: 0,
                added: items.length,
                updated: 0,
            };
        }

        const toEmbed: IndexableItem[] = [];
        let unchanged = 0;
        let added = 0;
        let updated = 0;

        for (const item of items) {
            const doc = existing[item.id];
            if (!doc) {
                toEmbed.push(item);
                added++;
            } else {
                try {
                    const stored = JSON.parse(doc.fields.content);
                    if (stored.checksum === item.checksum) {
                        unchanged++;
                    } else {
                        toEmbed.push(item);
                        updated++;
                    }
                } catch {
                    toEmbed.push(item);
                    updated++;
                }
            }
        }

        // Stale detection: IDs in previous index but not in current items
        const toDelete: string[] = [];
        for (const prevId of previousIds) {
            if (!currentIds.has(prevId)) {
                toDelete.push(prevId);
            }
        }

        return { toEmbed, toDelete, unchanged, added, updated };
    }

    /** Recursively embed with OOM retry, halving batch size on failure */
    private async embedBatchWithRetry(texts: string[], batchSize: number): Promise<number[][]> {
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            const chunk = texts.slice(i, i + batchSize);
            try {
                const vecs = await this.embedder.embedBatch!(chunk);
                results.push(...vecs);
            } catch {
                if (batchSize <= 16) {
                    // Last resort: sequential
                    for (const t of chunk) {
                        results.push(await this.embedder.embed(t));
                    }
                } else {
                    const smaller = await this.embedBatchWithRetry(chunk, Math.max(16, Math.floor(batchSize / 2)));
                    results.push(...smaller);
                }
            }
        }
        return results;
    }

    /** Dispatch upserts to worker threads. Returns false if all workers failed. */
    private async upsertViaWorkers(
        embedded: { item: { id: string; fields: Record<string, string> }; embedding: number[] }[],
        workerCount: number,
    ): Promise<boolean> {
        // Resolve the worker script path — use compiled JS if available, else TS via ts-node
        const workerScript = fs.pathExistsSync(path.join(__dirname, 'upsert-worker.js'))
            ? path.join(__dirname, 'upsert-worker.js')
            : path.join(__dirname, 'upsert-worker.ts');

        // Check if the worker script exists
        if (!fs.pathExistsSync(workerScript)) {
            return false; // Signal to fall back to main-thread upserts
        }

        const actualWorkerCount = Math.min(workerCount, embedded.length);
        if (actualWorkerCount === 0) return true;

        // Split items into per-worker batches
        const perWorker = Math.ceil(embedded.length / actualWorkerCount);
        const workerBatches: typeof embedded[] = [];
        for (let i = 0; i < embedded.length; i += perWorker) {
            workerBatches.push(embedded.slice(i, i + perWorker));
        }

        // Close our collection handle before workers open theirs
        // (zvec may not support concurrent handles from multiple threads)
        // Instead, we'll try workers and fall back if they can't open the collection.

        const promises = workerBatches.map(batch => {
            return new Promise<boolean>((resolve) => {
                let worker: Worker;
                const execArgv = workerScript.endsWith('.ts')
                    ? ['--require', 'ts-node/register']
                    : [];

                try {
                    worker = new Worker(workerScript, {
                        workerData: { collectionPath: this.collectionPath },
                        execArgv,
                    });
                } catch {
                    resolve(false);
                    return;
                }

                const items = batch.map(({ item, embedding }) => ({
                    id: item.id,
                    vectors: { embedding },
                    fields: item.fields,
                }));

                // Split into sub-batches and track completion
                const subBatchSize = 50;
                const subBatches: typeof items[] = [];
                for (let i = 0; i < items.length; i += subBatchSize) {
                    subBatches.push(items.slice(i, i + subBatchSize));
                }
                let completedSubBatches = 0;

                worker.on('message', (msg: any) => {
                    if (msg.type === 'done' || msg.type === 'error') {
                        completedSubBatches++;
                        if (completedSubBatches >= subBatches.length) {
                            worker.postMessage({ type: 'shutdown' });
                        }
                    }
                });

                worker.on('exit', (code) => {
                    resolve(code === 0);
                });

                worker.on('error', () => {
                    resolve(false);
                });

                for (const subBatch of subBatches) {
                    worker.postMessage({ type: 'batch', items: subBatch });
                }
            });
        });

        const results = await Promise.all(promises);
        return results.some(r => r); // At least one worker succeeded
    }

    async search(query: string, limit: number, typeFilter?: 'node' | 'spec'): Promise<SearchResult[]> {
        if (!this.collection) throw new Error('Collection not open');

        const embedding = await this.embedder.embed(query);

        const queryParams: any = {
            fieldName: 'embedding',
            vector: embedding,
            topk: limit,
            outputFields: ['type', 'original_id', 'name', 'content', 'path', 'kind', 'node_ids'],
        };

        if (typeFilter) {
            queryParams.filter = `type = '${typeFilter}'`;
        }

        const docs = this.collection.querySync(queryParams);
        const results = this.resolveResults(docs);
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    async get(id: string): Promise<SearchResult | null> {
        if (!this.collection) throw new Error('Collection not open');

        const encoded = encodeId(id);
        const docs = this.collection.fetchSync(encoded);
        const doc = docs[encoded];
        if (!doc) return null;

        const results = this.resolveResults([doc]);
        return results[0] || null;
    }

    async delete(id: string): Promise<boolean> {
        if (!this.collection) throw new Error('Collection not open');

        const encoded = encodeId(id);
        const docs = this.collection.fetchSync(encoded);
        if (!docs[encoded]) return false;

        this.collection.deleteSync(encoded);
        return true;
    }

    close(): void {
        if (this.collection) {
            try {
                this.collection.closeSync();
            } catch {
                // Ignore close errors
            }
            this.collection = null;
        }
    }

    private resolveResults(docs: any[]): SearchResult[] {
        // Load spec-map for linked node resolution
        let specMap: SpecMap | null = null;
        const specMapPath = path.join(this.rootPath, '.drew', 'spec-map.json');
        if (fs.pathExistsSync(specMapPath)) {
            specMap = fs.readJsonSync(specMapPath);
        }

        return docs.map(doc => {
            const type = doc.fields?.type as 'node' | 'spec';
            const originalId = doc.fields?.original_id || doc.id;
            const content = doc.fields?.content;
            const data = content ? JSON.parse(content) : {};

            const result: SearchResult = {
                id: originalId,
                type: type || 'node',
                score: doc.score ?? 0,
                data,
            };

            // Resolve linked nodes for spec documents
            if (type === 'spec' && specMap) {
                const nodeIdsStr = doc.fields?.node_ids;
                if (nodeIdsStr && nodeIdsStr !== '') {
                    const nodeIds: string[] = JSON.parse(nodeIdsStr);
                    result.linkedNodes = nodeIds
                        .map(nid => specMap!.nodes[nid])
                        .filter(Boolean);
                }
            }

            return result;
        });
    }
}
