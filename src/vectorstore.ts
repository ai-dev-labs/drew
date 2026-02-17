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

/** Auto-tune batch size based on available memory. Clamps to [100, 128], but never exceeds totalItems. */
export function determineBatchSize(totalItems: number, memOverride?: number): number {
    // Use total memory instead of free memory — os.freemem() is unreliable on
    // macOS where aggressive file caching causes it to report very low values
    // (e.g. ~100MB on a 16GB machine), always hitting the minimum clamp.
    const mem = memOverride ?? os.totalmem();
    // ~2MB per item in batch (tensors + intermediate)
    const memoryBudget = Math.floor(mem * 0.3);
    const maxByMemory = Math.floor(memoryBudget / (2 * 1024 * 1024));
    const clamped = Math.max(100, Math.min(128, maxByMemory));
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

        // ── Pipelined Embedding + Upsert ──
        // Close collection before embedding loop (worker needs exclusive write access).
        // Embedding does not need the collection handle.
        this.collection.closeSync();
        this.collection = null;

        const batchSize = determineBatchSize(diff.toEmbed.length);

        // Track all items sent to worker for fallback recovery
        const sentItems: { id: string; vectors: { embedding: number[] }; fields: Record<string, string> }[] = [];

        // Spawn upsert worker
        const { worker, exitPromise } = this.spawnUpsertWorker();
        let workerAlive = !!worker;

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

            // Build upsert items and post to worker immediately
            const upsertItems = batch.map((item, j) => ({
                id: item.id,
                vectors: { embedding: embeddings[j] },
                fields: item.fields,
            }));

            sentItems.push(...upsertItems);

            if (workerAlive && worker) {
                try {
                    worker.postMessage({ type: 'batch', items: upsertItems });
                } catch {
                    workerAlive = false;
                }
            }

            progress.increment(batch.length);
        }

        // Signal worker shutdown and await exit
        let workerSucceeded = false;
        if (workerAlive && worker) {
            worker.postMessage({ type: 'shutdown' });
            const exitCode = await exitPromise;
            workerSucceeded = exitCode === 0;
        } else {
            // Worker was never alive or died — await promise to clean up
            await exitPromise;
        }

        // Reopen collection for deletes + optimize
        this.collection = ZVecOpen(this.collectionPath);

        // Fallback: if worker failed, upsert all sent items on main thread using batch API
        if (!workerSucceeded && sentItems.length > 0) {
            this.collection.upsertSync(sentItems);
        }

        // ── Delete stale entries ──
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

    /** Spawn a single upsert worker thread. Returns the worker and a promise for its exit code. */
    private spawnUpsertWorker(): { worker: Worker | null; exitPromise: Promise<number> } {
        const workerScript = fs.pathExistsSync(path.join(__dirname, 'upsert-worker.js'))
            ? path.join(__dirname, 'upsert-worker.js')
            : path.join(__dirname, 'upsert-worker.ts');

        if (!fs.pathExistsSync(workerScript)) {
            return { worker: null, exitPromise: Promise.resolve(1) };
        }

        const execArgv = workerScript.endsWith('.ts')
            ? ['--require', 'ts-node/register']
            : [];

        try {
            const worker = new Worker(workerScript, {
                workerData: { collectionPath: this.collectionPath },
                execArgv,
            });

            const exitPromise = new Promise<number>((resolve) => {
                worker.on('exit', (code) => resolve(code ?? 1));
                worker.on('error', () => resolve(1));
            });

            return { worker, exitPromise };
        } catch {
            return { worker: null, exitPromise: Promise.resolve(1) };
        }
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
