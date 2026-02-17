import { expect } from 'chai';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { DrewVectorStore } from '../src/vectorstore';
import { SimpleEmbeddingProvider, EmbeddingProvider } from '../src/embeddings';
import { SpecMap, CodeGraphNode, Requirement } from '../src/engine';

/** Build a minimal SpecMap with N synthetic nodes and optional specs */
function buildSpecMap(nodeCount: number, specCount = 0): SpecMap {
    const nodes: Record<string, CodeGraphNode> = {};
    for (let i = 0; i < nodeCount; i++) {
        const id = `src/file${i}.ts:func${i}`;
        nodes[id] = {
            id,
            kind: 'function_declaration',
            name: `func${i}`,
            namespace: [],
            path: `src/file${i}.ts`,
            start_byte: 0,
            end_byte: 100,
            start_line: 1,
            end_line: 10,
            checksum: `checksum-${i}`,
            summary: `Function ${i} does thing ${i}. It processes data and returns results for scenario ${i}.`,
        };
    }

    const specifications: Record<string, Requirement> | undefined =
        specCount > 0 ? {} : undefined;
    if (specifications) {
        for (let i = 0; i < specCount; i++) {
            const id = `REQ-TEST-${i}`;
            specifications[id] = {
                id,
                description: `Requirement ${i} for testing batch indexing`,
                acceptance_criteria: [`Criterion A for req ${i}`, `Criterion B for req ${i}`],
                node_ids: [`src/file${i}.ts:func${i}`],
                checksum: `spec-checksum-${i}`,
            };
        }
    }

    return { nodes, specifications };
}

describe('DrewVectorStore - batch indexing pipeline', () => {
    let tempDir: string;
    let store: DrewVectorStore;
    let embedder: SimpleEmbeddingProvider;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-vs-test-'));
        // Create .drew directory and spec-map for linked node resolution
        await fs.ensureDir(path.join(tempDir, '.drew'));
        embedder = new SimpleEmbeddingProvider();
        await embedder.initialize();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(true);
    });

    afterEach(async () => {
        store.close();
        await fs.remove(tempDir);
    });

    describe('indexAll with batch embedding', () => {
        it('should index all nodes from a specMap', async () => {
            const specMap = buildSpecMap(20);
            const result = await store.indexAll(specMap);
            expect(result.nodes).to.equal(20);
            expect(result.specs).to.equal(0);
        });

        it('should index nodes and specs together', async () => {
            const specMap = buildSpecMap(15, 5);
            const result = await store.indexAll(specMap);
            expect(result.nodes).to.equal(15);
            expect(result.specs).to.equal(5);
        });

        it('should index a large batch (100 items)', async () => {
            const specMap = buildSpecMap(80, 20);
            const result = await store.indexAll(specMap);
            expect(result.nodes).to.equal(80);
            expect(result.specs).to.equal(20);
        });

        it('should handle empty specMap', async () => {
            const specMap: SpecMap = { nodes: {} };
            const result = await store.indexAll(specMap);
            expect(result.nodes).to.equal(0);
            expect(result.specs).to.equal(0);
        });

        it('should handle specMap with single item', async () => {
            const specMap = buildSpecMap(1);
            const result = await store.indexAll(specMap);
            expect(result.nodes).to.equal(1);
        });
    });

    describe('search after batch-indexed data', () => {
        it('should find indexed nodes by semantic search', async () => {
            const specMap = buildSpecMap(10);
            await store.indexAll(specMap);

            const results = await store.search('function that processes data', 5);
            expect(results.length).to.be.greaterThan(0);
            expect(results[0].type).to.equal('node');
        });

        it('should find indexed specs by search', async () => {
            const specMap = buildSpecMap(5, 5);
            // Write spec-map so linked node resolution works
            await fs.writeJson(path.join(tempDir, '.drew', 'spec-map.json'), specMap);
            await store.indexAll(specMap);

            const results = await store.search('requirement for testing batch', 5, 'spec');
            expect(results.length).to.be.greaterThan(0);
            expect(results[0].type).to.equal('spec');
        });

        it('should return correct data in search results', async () => {
            const specMap = buildSpecMap(3);
            await store.indexAll(specMap);

            const results = await store.search('func0 processes data', 3);
            expect(results.length).to.be.greaterThan(0);
            const found = results.find(r => r.id.includes('func0'));
            if (found) {
                expect(found.type).to.equal('node');
                expect((found.data as CodeGraphNode).name).to.equal('func0');
            }
        });
    });

    describe('indexAll with non-batch provider fallback', () => {
        it('should work with a provider that lacks embedBatch', async () => {
            const minimalEmbedder: EmbeddingProvider = {
                dimension: 512,
                async initialize() {},
                async embed(text: string) {
                    // Return a deterministic 512-dim vector
                    const vec = new Array(512).fill(0);
                    for (let i = 0; i < Math.min(text.length, 512); i++) {
                        vec[i] = text.charCodeAt(i) / 255;
                    }
                    return vec;
                },
            };

            const fallbackStore = new DrewVectorStore(tempDir, minimalEmbedder);
            // Need a fresh collection for this test
            store.close();
            await fs.remove(path.join(tempDir, '.drew', '.data'));
            await fallbackStore.create(true);

            const specMap = buildSpecMap(10);
            const result = await fallbackStore.indexAll(specMap);
            expect(result.nodes).to.equal(10);
            fallbackStore.close();
        });
    });
});

describe('DrewVectorStore - incremental indexing', function () {
    this.timeout(10000);

    let tempDir: string;
    let store: DrewVectorStore;
    let embedder: SimpleEmbeddingProvider;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-incr-test-'));
        await fs.ensureDir(path.join(tempDir, '.drew'));
        embedder = new SimpleEmbeddingProvider();
        await embedder.initialize();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(true);
    });

    afterEach(async () => {
        store.close();
        await fs.remove(tempDir);
    });

    it('IT-1: first index run should embed and upsert all items', async () => {
        const specMap = buildSpecMap(20);
        const result = await store.indexAll(specMap);
        expect(result.nodes).to.equal(20);
        expect(result.specs).to.equal(0);
        expect(result.added).to.equal(20);
        expect(result.updated).to.equal(0);
        expect(result.removed).to.equal(0);
        expect(result.unchanged).to.equal(0);
    });

    it('IT-2: second run with no changes should skip everything', async () => {
        const specMap = buildSpecMap(20);
        await store.indexAll(specMap);

        // Close and reopen to simulate a fresh run
        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(false);

        const result = await store.indexAll(specMap);
        expect(result.unchanged).to.equal(20);
        expect(result.added).to.equal(0);
        expect(result.updated).to.equal(0);
        expect(result.removed).to.equal(0);
    });

    it('IT-3: second run with changed items should only re-index changed', async () => {
        const specMap = buildSpecMap(20);
        await store.indexAll(specMap);

        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(false);

        // Modify 3 items' checksums
        specMap.nodes['src/file0.ts:func0'].checksum = 'changed-0';
        specMap.nodes['src/file1.ts:func1'].checksum = 'changed-1';
        specMap.nodes['src/file2.ts:func2'].checksum = 'changed-2';

        const result = await store.indexAll(specMap);
        expect(result.updated).to.equal(3);
        expect(result.unchanged).to.equal(17);
        expect(result.added).to.equal(0);
        expect(result.removed).to.equal(0);
    });

    it('IT-4: second run with deleted items should prune stale entries', async () => {
        const specMap = buildSpecMap(20);
        await store.indexAll(specMap);

        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(false);

        // Remove 2 items from spec-map
        delete specMap.nodes['src/file18.ts:func18'];
        delete specMap.nodes['src/file19.ts:func19'];

        const result = await store.indexAll(specMap);
        expect(result.removed).to.equal(2);
        expect(result.unchanged).to.equal(18);
        expect(result.added).to.equal(0);
        expect(result.updated).to.equal(0);
    });

    it('IT-5: second run with mixed changes should report correct counts', async () => {
        const specMap = buildSpecMap(20);
        await store.indexAll(specMap);

        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(false);

        // Add 2 new items
        for (let i = 20; i < 22; i++) {
            const id = `src/file${i}.ts:func${i}`;
            specMap.nodes[id] = {
                id,
                kind: 'function_declaration',
                name: `func${i}`,
                namespace: [],
                path: `src/file${i}.ts`,
                start_byte: 0,
                end_byte: 100,
                start_line: 1,
                end_line: 10,
                checksum: `checksum-${i}`,
                summary: `Function ${i} does thing ${i}.`,
            };
        }

        // Update 3 existing items
        specMap.nodes['src/file0.ts:func0'].checksum = 'changed-0';
        specMap.nodes['src/file1.ts:func1'].checksum = 'changed-1';
        specMap.nodes['src/file2.ts:func2'].checksum = 'changed-2';

        // Delete 1 item
        delete specMap.nodes['src/file19.ts:func19'];

        const result = await store.indexAll(specMap);
        expect(result.added).to.equal(2);
        expect(result.updated).to.equal(3);
        expect(result.removed).to.equal(1);
        expect(result.unchanged).to.equal(16);
    });

    it('IT-6: search after incremental index should find updated content', async () => {
        const specMap = buildSpecMap(10);
        await fs.writeJson(path.join(tempDir, '.drew', 'spec-map.json'), specMap);
        await store.indexAll(specMap);

        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(false);

        // Modify one item's summary and checksum
        specMap.nodes['src/file0.ts:func0'].summary = 'Completely unique unicorn rainbow description';
        specMap.nodes['src/file0.ts:func0'].checksum = 'changed-0';
        await fs.writeJson(path.join(tempDir, '.drew', 'spec-map.json'), specMap);

        const result = await store.indexAll(specMap);
        expect(result.updated).to.equal(1);
        expect(result.unchanged).to.equal(9);

        // Verify the updated item is retrievable with correct content
        const fetched = await store.get('src/file0.ts:func0');
        expect(fetched).to.not.be.null;
        expect((fetched!.data as CodeGraphNode).summary).to.equal('Completely unique unicorn rainbow description');
    });

    it('IT-7: --reindex should ignore incremental logic and rebuild all', async () => {
        const specMap = buildSpecMap(20);
        await store.indexAll(specMap);

        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(true); // reindex=true

        const result = await store.indexAll(specMap);
        // With reindex, all items are treated as new
        expect(result.added).to.equal(20);
        expect(result.unchanged).to.equal(0);
        expect(result.updated).to.equal(0);
        expect(result.removed).to.equal(0);
    });

    it('should handle missing .index-ids.json gracefully on first run', async () => {
        // Ensure no sidecar file exists
        const idsPath = path.join(tempDir, '.drew', '.index-ids.json');
        if (await fs.pathExists(idsPath)) {
            await fs.remove(idsPath);
        }

        const specMap = buildSpecMap(5);
        const result = await store.indexAll(specMap);
        expect(result.added).to.equal(5);
        expect(result.removed).to.equal(0);
    });

    it('should create .index-ids.json after indexing', async () => {
        const specMap = buildSpecMap(10);
        await store.indexAll(specMap);

        const idsPath = path.join(tempDir, '.drew', '.index-ids.json');
        expect(await fs.pathExists(idsPath)).to.be.true;

        const ids = await fs.readJson(idsPath);
        expect(ids).to.be.an('array').with.lengthOf(10);
    });

    it('should handle specs in incremental indexing', async () => {
        const specMap = buildSpecMap(10, 5);
        await store.indexAll(specMap);

        store.close();
        store = new DrewVectorStore(tempDir, embedder);
        await store.create(false);

        // Modify one spec's checksum
        specMap.specifications!['REQ-TEST-0'].checksum = 'changed-spec-0';

        const result = await store.indexAll(specMap);
        expect(result.updated).to.equal(1);
        expect(result.unchanged).to.equal(14); // 10 nodes + 4 unchanged specs
    });
});

describe('determineBatchSize', () => {
    // We'll import the function once it's implemented.
    // For now these tests describe the expected behavior.

    it('should clamp batch size to minimum of 16', async () => {
        // With very low free memory, batch size should not go below 16
        const { determineBatchSize } = require('../src/vectorstore');
        const result = determineBatchSize(1000, 1 * 1024 * 1024); // 1MB free
        expect(result).to.be.at.least(16);
    });

    it('should clamp batch size to maximum of 128', async () => {
        const { determineBatchSize } = require('../src/vectorstore');
        const result = determineBatchSize(1000, 100 * 1024 * 1024 * 1024); // 100GB free
        expect(result).to.be.at.most(128);
    });

    it('should not exceed totalItems', async () => {
        const { determineBatchSize } = require('../src/vectorstore');
        const result = determineBatchSize(5, 8 * 1024 * 1024 * 1024); // 8GB free, only 5 items
        expect(result).to.be.at.most(5);
    });

    it('should use 30% of free memory at ~2MB per item', async () => {
        const { determineBatchSize } = require('../src/vectorstore');
        // 200MB free → 30% = 60MB → 60/2 = 30 items
        const result = determineBatchSize(1000, 200 * 1024 * 1024);
        expect(result).to.equal(30);
    });
});
