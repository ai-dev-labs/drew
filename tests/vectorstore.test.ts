import { expect } from 'chai';
import { DrewVectorStore, SearchResult } from '../src/vectorstore';
import { SimpleEmbeddingProvider } from '../src/embeddings';
import { SpecMap, CodeGraphNode, Requirement } from '../src/engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

function makeSpecMap(): SpecMap {
    const nodes: Record<string, CodeGraphNode> = {
        'src/engine.ts:extractAll': {
            id: 'src/engine.ts:extractAll',
            kind: 'function_declaration',
            name: 'extractAll',
            namespace: [],
            path: 'src/engine.ts',
            start_byte: 100,
            end_byte: 500,
            start_line: 10,
            end_line: 50,
            checksum: 'abc123',
            summary: 'Main extraction pipeline that walks the project directory and extracts code symbols.'
        },
        'src/summarizer.ts:summarize': {
            id: 'src/summarizer.ts:summarize',
            kind: 'method_definition',
            name: 'summarize',
            namespace: [],
            path: 'src/summarizer.ts',
            start_byte: 200,
            end_byte: 400,
            start_line: 20,
            end_line: 40,
            checksum: 'def456',
            summary: 'Generates AI-powered summaries for code symbols using configured LLM provider.'
        },
        'src/engine.ts:saveSpecMap': {
            id: 'src/engine.ts:saveSpecMap',
            kind: 'function_declaration',
            name: 'saveSpecMap',
            namespace: [],
            path: 'src/engine.ts',
            start_byte: 600,
            end_byte: 700,
            start_line: 60,
            end_line: 70,
            checksum: 'ghi789',
            summary: 'Persists the spec map to disk as JSON in the .drew directory.'
        }
    };

    const specifications: Record<string, Requirement> = {
        'REQ-EXTRACTALL-1': {
            id: 'REQ-EXTRACTALL-1',
            description: 'The system SHALL extract all code symbols from supported source files.',
            acceptance_criteria: [
                'The extraction SHALL include functions, classes, and interfaces.',
                'The extraction SHALL skip files matching .drewignore patterns.'
            ],
            node_ids: ['src/engine.ts:extractAll'],
            checksum: 'spec-check-1'
        },
        'REQ-SUMMARIZE-1': {
            id: 'REQ-SUMMARIZE-1',
            description: 'The system SHALL generate technical summaries for extracted code symbols.',
            acceptance_criteria: [
                'Summaries SHALL be 1-3 sentences long.',
                'Summaries SHALL be generated using the configured LLM provider.'
            ],
            node_ids: ['src/summarizer.ts:summarize', 'src/engine.ts:saveSpecMap'],
            checksum: 'spec-check-2'
        }
    };

    return { nodes, specifications };
}

describe('DrewVectorStore', () => {
    let tempDir: string;
    let store: DrewVectorStore;
    let specMap: SpecMap;

    beforeEach(async function() {
        this.timeout(10000);
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-vec-test-'));
        // Save a spec-map.json so the store can resolve linked nodes
        specMap = makeSpecMap();
        await fs.ensureDir(path.join(tempDir, '.drew'));
        await fs.writeJson(path.join(tempDir, '.drew', 'spec-map.json'), specMap, { spaces: 2 });

        store = new DrewVectorStore(tempDir, new SimpleEmbeddingProvider());
        await store.create(false);
    });

    afterEach(async function() {
        this.timeout(10000);
        store.close();
        await fs.remove(tempDir);
    });

    describe('indexAll', () => {
        it('should index all nodes and specifications', async function() {
            this.timeout(15000);
            const result = await store.indexAll(specMap);
            expect(result.nodes).to.equal(3);
            expect(result.specs).to.equal(2);
        });
    });

    describe('search', () => {
        beforeEach(async function() {
            this.timeout(15000);
            await store.indexAll(specMap);
        });

        it('should return results for a query', async function() {
            this.timeout(10000);
            const results = await store.search('extract symbols', 10);
            expect(results).to.be.an('array');
            expect(results.length).to.be.greaterThan(0);
        });

        it('should respect the limit parameter', async function() {
            this.timeout(10000);
            const results = await store.search('code', 2);
            expect(results.length).to.be.at.most(2);
        });

        it('should return results with score, type, and data', async function() {
            this.timeout(10000);
            const results = await store.search('extraction', 10);
            for (const r of results) {
                expect(r).to.have.property('id');
                expect(r).to.have.property('type').that.is.oneOf(['node', 'spec']);
                expect(r).to.have.property('score').that.is.a('number');
                expect(r).to.have.property('data');
            }
        });

        it('should resolve linked nodes for spec results', async function() {
            this.timeout(10000);
            const results = await store.search('summarize technical', 10);
            const specResult = results.find(r => r.type === 'spec');
            if (specResult) {
                expect(specResult.linkedNodes).to.be.an('array');
                expect(specResult.linkedNodes!.length).to.be.greaterThan(0);
            }
        });

        it('should filter by type when specified', async function() {
            this.timeout(10000);
            const nodeResults = await store.search('code', 10, 'node');
            for (const r of nodeResults) {
                expect(r.type).to.equal('node');
            }

            const specResults = await store.search('code', 10, 'spec');
            for (const r of specResults) {
                expect(r.type).to.equal('spec');
            }
        });
    });

    describe('get', () => {
        beforeEach(async function() {
            this.timeout(15000);
            await store.indexAll(specMap);
        });

        it('should return a node by ID', async function() {
            this.timeout(10000);
            const result = await store.get('src/engine.ts:extractAll');
            expect(result).to.not.be.null;
            expect(result!.id).to.equal('src/engine.ts:extractAll');
            expect(result!.type).to.equal('node');
        });

        it('should return a spec by ID with linked nodes', async function() {
            this.timeout(10000);
            const result = await store.get('REQ-SUMMARIZE-1');
            expect(result).to.not.be.null;
            expect(result!.id).to.equal('REQ-SUMMARIZE-1');
            expect(result!.type).to.equal('spec');
            expect(result!.linkedNodes).to.be.an('array');
            expect(result!.linkedNodes!.length).to.equal(2);
            const linkedIds = result!.linkedNodes!.map(n => n.id);
            expect(linkedIds).to.include('src/summarizer.ts:summarize');
            expect(linkedIds).to.include('src/engine.ts:saveSpecMap');
        });

        it('should return null for non-existent ID', async function() {
            this.timeout(10000);
            const result = await store.get('nonexistent:id');
            expect(result).to.be.null;
        });
    });

    describe('delete', () => {
        beforeEach(async function() {
            this.timeout(15000);
            await store.indexAll(specMap);
        });

        it('should delete a document by ID', async function() {
            this.timeout(10000);
            const deleted = await store.delete('src/engine.ts:extractAll');
            expect(deleted).to.be.true;

            const result = await store.get('src/engine.ts:extractAll');
            expect(result).to.be.null;
        });

        it('should return false for non-existent ID', async function() {
            this.timeout(10000);
            const deleted = await store.delete('nonexistent:id');
            expect(deleted).to.be.false;
        });
    });

    describe('reindex', () => {
        it('should destroy and recreate the collection', async function() {
            this.timeout(15000);
            await store.indexAll(specMap);
            let result = await store.get('src/engine.ts:extractAll');
            expect(result).to.not.be.null;

            store.close();

            // Recreate with reindex=true
            store = new DrewVectorStore(tempDir, new SimpleEmbeddingProvider());
            await store.create(true);

            // Collection should be empty after reindex
            result = await store.get('src/engine.ts:extractAll');
            expect(result).to.be.null;
        });
    });
});
