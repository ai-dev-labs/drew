import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as cliProgress from 'cli-progress';
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

const PARALLEL_INDEX = 10;

export interface SearchResult {
    id: string;
    type: 'node' | 'spec';
    score: number;
    data: CodeGraphNode | Requirement;
    linkedNodes?: CodeGraphNode[];
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

        if (reindex && await fs.pathExists(this.collectionPath)) {
            await fs.remove(this.collectionPath);
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

    async indexAll(specMap: SpecMap): Promise<{ nodes: number; specs: number }> {
        if (!this.collection) throw new Error('Collection not open');

        const nodes = Object.values(specMap.nodes);
        const specs = Object.values(specMap.specifications ?? {});
        const total = nodes.length + specs.length;

        const progress = new cliProgress.SingleBar({
            format: 'Indexing | {bar} | {percentage}% | {value}/{total} Documents',
        }, cliProgress.Presets.shades_classic);
        progress.start(total, 0);

        // Prepare items with their text and field builders
        const items: { text: string; id: string; fields: Record<string, string> }[] = [];

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
            });
        }

        // Embed and upsert with bounded concurrency
        await mapWithConcurrency(items, PARALLEL_INDEX, async (item) => {
            const embedding = await this.embedder.embed(item.text);
            this.collection.upsertSync({
                id: item.id,
                vectors: { embedding },
                fields: item.fields,
            });
            progress.increment();
        });

        progress.stop();

        this.collection.optimizeSync();

        return { nodes: nodes.length, specs: specs.length };
    }

    async search(query: string, limit: number, typeFilter?: 'node' | 'spec'): Promise<SearchResult[]> {
        if (!this.collection) throw new Error('Collection not open');

        const embedding = await this.embedder.embed(query);

        const queryParams: any = {
            fieldName: 'embedding',
            vector: embedding,
            topk: limit,
            outputFields: ['type', 'name', 'content', 'path', 'kind', 'node_ids'],
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
