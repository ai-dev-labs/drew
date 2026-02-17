import { expect } from 'chai';
import { MultiRepoResolver, RepoInfo, MultiRepoSearchResult } from '../src/multi-repo';
import { DrewVectorStore } from '../src/vectorstore';
import { SimpleEmbeddingProvider } from '../src/embeddings';
import { SpecMap, CodeGraphNode, Requirement } from '../src/engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

function makeSpecMap(repoPrefix: string): SpecMap {
    const nodes: Record<string, CodeGraphNode> = {
        [`${repoPrefix}/src/main.ts:main`]: {
            id: `${repoPrefix}/src/main.ts:main`,
            kind: 'function_declaration',
            name: 'main',
            namespace: [],
            path: `${repoPrefix}/src/main.ts`,
            start_byte: 0,
            end_byte: 100,
            start_line: 1,
            end_line: 10,
            checksum: `${repoPrefix}-main-check`,
            summary: `Main entry point for ${repoPrefix} application.`
        },
        [`${repoPrefix}/src/util.ts:helper`]: {
            id: `${repoPrefix}/src/util.ts:helper`,
            kind: 'function_declaration',
            name: 'helper',
            namespace: [],
            path: `${repoPrefix}/src/util.ts`,
            start_byte: 0,
            end_byte: 50,
            start_line: 1,
            end_line: 5,
            checksum: `${repoPrefix}-helper-check`,
            summary: `Utility helper function for ${repoPrefix}.`
        }
    };

    const specifications: Record<string, Requirement> = {
        [`REQ-${repoPrefix.toUpperCase()}-1`]: {
            id: `REQ-${repoPrefix.toUpperCase()}-1`,
            description: `The ${repoPrefix} system SHALL provide its core functionality.`,
            acceptance_criteria: [
                `The ${repoPrefix} system SHALL initialize correctly.`
            ],
            node_ids: [`${repoPrefix}/src/main.ts:main`],
            checksum: `${repoPrefix}-spec-check`
        }
    };

    return { nodes, specifications };
}

async function setupMockRepo(parentDir: string, repoName: string): Promise<string> {
    const repoPath = path.join(parentDir, repoName);
    const drewDir = path.join(repoPath, '.drew');

    await fs.ensureDir(drewDir);

    const specMap = makeSpecMap(repoName);
    await fs.writeJson(path.join(drewDir, 'spec-map.json'), specMap, { spaces: 2 });

    // Index the repo
    const embedder = new SimpleEmbeddingProvider();
    const store = new DrewVectorStore(repoPath, embedder);
    await store.create(false);
    await store.indexAll(specMap);
    store.close();

    return repoPath;
}

describe('MultiRepoResolver', () => {
    let parentDir: string;
    let cwdRepo: string;

    beforeEach(async function() {
        this.timeout(30000);
        parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-multi-test-'));

        // Create 3 sibling repos: repo-a, repo-b, repo-c (cwd)
        await setupMockRepo(parentDir, 'repo-a');
        await setupMockRepo(parentDir, 'repo-b');
        cwdRepo = await setupMockRepo(parentDir, 'repo-c');
    });

    afterEach(async function() {
        this.timeout(10000);
        await fs.remove(parentDir);
    });

    describe('discoverSiblingRepos', () => {
        it('should discover sibling repos with .drew/.data', async function() {
            const resolver = new MultiRepoResolver(cwdRepo);
            const repos = await resolver.discoverSiblingRepos();

            expect(repos).to.be.an('array');
            // Should find repo-a and repo-b (siblings), not repo-c (self)
            const names = repos.map(r => r.name);
            expect(names).to.include('repo-a');
            expect(names).to.include('repo-b');
            expect(names).to.not.include('repo-c');
        });

        it('should skip directories without .drew/.data', async function() {
            // Create a directory without drew index
            await fs.ensureDir(path.join(parentDir, 'not-a-repo'));

            const resolver = new MultiRepoResolver(cwdRepo);
            const repos = await resolver.discoverSiblingRepos();

            const names = repos.map(r => r.name);
            expect(names).to.not.include('not-a-repo');
        });

        it('should skip files in parent directory', async function() {
            // Create a file (not directory) in parent
            await fs.writeFile(path.join(parentDir, 'some-file.txt'), 'hello');

            const resolver = new MultiRepoResolver(cwdRepo);
            const repos = await resolver.discoverSiblingRepos();

            // Should still find the real repos without error
            const names = repos.map(r => r.name);
            expect(names).to.include('repo-a');
            expect(names).to.include('repo-b');
        });

        it('should return empty array when no siblings have .drew/.data', async function() {
            // Create isolated dir with only the cwd repo
            const isolatedParent = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-isolated-'));
            const isolatedRepo = await setupMockRepo(isolatedParent, 'only-repo');

            const resolver = new MultiRepoResolver(isolatedRepo);
            const repos = await resolver.discoverSiblingRepos();

            expect(repos).to.be.an('array');
            expect(repos).to.have.length(0);

            await fs.remove(isolatedParent);
        });
    });

    describe('openAll', () => {
        it('should open all discovered repos', async function() {
            this.timeout(15000);
            const resolver = new MultiRepoResolver(cwdRepo);
            const result = await resolver.openAll();

            expect(result.opened).to.be.an('array');
            expect(result.opened).to.include('repo-a');
            expect(result.opened).to.include('repo-b');
            expect(result.failed).to.be.an('array');
            expect(result.failed).to.have.length(0);

            resolver.closeAll();
        });

        it('should report repos that fail to open', async function() {
            this.timeout(15000);
            // Corrupt repo-a's data directory
            await fs.remove(path.join(parentDir, 'repo-a', '.drew', '.data'));
            await fs.writeFile(path.join(parentDir, 'repo-a', '.drew', '.data'), 'not a directory');

            const resolver = new MultiRepoResolver(cwdRepo);
            const result = await resolver.openAll();

            expect(result.opened).to.include('repo-b');
            expect(result.failed).to.include('repo-a');

            resolver.closeAll();
        });
    });

    describe('searchAll', () => {
        let resolver: MultiRepoResolver;

        beforeEach(async function() {
            this.timeout(15000);
            resolver = new MultiRepoResolver(cwdRepo);
            await resolver.openAll();
        });

        afterEach(() => {
            resolver.closeAll();
        });

        it('should return results from multiple repos', async function() {
            this.timeout(15000);
            const results = await resolver.searchAll('main entry point', 20);

            expect(results).to.be.an('array');
            expect(results.length).to.be.greaterThan(0);

            // Results should have repo field
            for (const r of results) {
                expect(r).to.have.property('repo').that.is.a('string');
                expect(r.repo).to.be.oneOf(['repo-a', 'repo-b']);
            }
        });

        it('should merge results sorted by score', async function() {
            this.timeout(15000);
            const results = await resolver.searchAll('function', 20);

            // Verify descending score order
            for (let i = 1; i < results.length; i++) {
                expect(results[i].score).to.be.at.most(results[i - 1].score);
            }
        });

        it('should respect the limit parameter', async function() {
            this.timeout(15000);
            const results = await resolver.searchAll('function', 2);
            expect(results.length).to.be.at.most(2);
        });

        it('should respect type filter', async function() {
            this.timeout(15000);
            const specResults = await resolver.searchAll('system', 20, 'spec');
            for (const r of specResults) {
                expect(r.type).to.equal('spec');
            }
        });

        it('should tag results with source repo name', async function() {
            this.timeout(15000);
            const results = await resolver.searchAll('utility helper', 20);

            const repos = new Set(results.map(r => r.repo));
            // Should have results from at least one repo
            expect(repos.size).to.be.greaterThan(0);
        });
    });

    describe('searchRepo', () => {
        let resolver: MultiRepoResolver;

        beforeEach(async function() {
            this.timeout(15000);
            resolver = new MultiRepoResolver(cwdRepo);
            await resolver.openAll();
        });

        afterEach(() => {
            resolver.closeAll();
        });

        it('should search a specific repo by name', async function() {
            this.timeout(15000);
            const results = await resolver.searchRepo('repo-a', 'main', 10);

            expect(results).to.be.an('array');
            for (const r of results) {
                expect(r.repo).to.equal('repo-a');
            }
        });

        it('should throw for unknown repo name', async function() {
            try {
                await resolver.searchRepo('nonexistent', 'query', 10);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('not found');
            }
        });
    });

    describe('getAll', () => {
        let resolver: MultiRepoResolver;

        beforeEach(async function() {
            this.timeout(15000);
            resolver = new MultiRepoResolver(cwdRepo);
            await resolver.openAll();
        });

        afterEach(() => {
            resolver.closeAll();
        });

        it('should return matches from all repos', async function() {
            this.timeout(15000);
            // Both repos have an id with this pattern but different prefixes
            // Get from repo-a specifically
            const results = await resolver.getAll('repo-a/src/main.ts:main');

            expect(results).to.be.an('array');
            expect(results.length).to.be.greaterThan(0);
            expect(results[0].repo).to.equal('repo-a');
        });

        it('should return empty array for non-existent ID', async function() {
            this.timeout(15000);
            const results = await resolver.getAll('nonexistent:id');
            expect(results).to.be.an('array');
            expect(results).to.have.length(0);
        });
    });

    describe('getFromRepo', () => {
        let resolver: MultiRepoResolver;

        beforeEach(async function() {
            this.timeout(15000);
            resolver = new MultiRepoResolver(cwdRepo);
            await resolver.openAll();
        });

        afterEach(() => {
            resolver.closeAll();
        });

        it('should get a document from a specific repo', async function() {
            this.timeout(15000);
            const result = await resolver.getFromRepo('repo-a', 'repo-a/src/main.ts:main');

            expect(result).to.not.be.null;
            expect(result!.repo).to.equal('repo-a');
            expect(result!.result.id).to.equal('repo-a/src/main.ts:main');
        });

        it('should return null for non-existent ID in specific repo', async function() {
            this.timeout(15000);
            const result = await resolver.getFromRepo('repo-a', 'nonexistent:id');
            expect(result).to.be.null;
        });

        it('should throw for unknown repo name', async function() {
            try {
                await resolver.getFromRepo('nonexistent', 'some:id');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('not found');
            }
        });
    });

    describe('deleteFromRepo', () => {
        let resolver: MultiRepoResolver;

        beforeEach(async function() {
            this.timeout(15000);
            resolver = new MultiRepoResolver(cwdRepo);
            await resolver.openAll();
        });

        afterEach(() => {
            resolver.closeAll();
        });

        it('should delete a document from a specific repo', async function() {
            this.timeout(15000);
            const deleted = await resolver.deleteFromRepo('repo-a', 'repo-a/src/main.ts:main');
            expect(deleted).to.be.true;

            // Verify it's gone
            const result = await resolver.getFromRepo('repo-a', 'repo-a/src/main.ts:main');
            expect(result).to.be.null;
        });

        it('should return false for non-existent ID', async function() {
            this.timeout(15000);
            const deleted = await resolver.deleteFromRepo('repo-a', 'nonexistent:id');
            expect(deleted).to.be.false;
        });

        it('should throw for unknown repo name', async function() {
            try {
                await resolver.deleteFromRepo('nonexistent', 'some:id');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('not found');
            }
        });
    });

    describe('helpers', () => {
        it('should list repo names after openAll', async function() {
            this.timeout(15000);
            const resolver = new MultiRepoResolver(cwdRepo);
            await resolver.openAll();

            const names = resolver.getRepoNames();
            expect(names).to.include('repo-a');
            expect(names).to.include('repo-b');

            expect(resolver.hasRepo('repo-a')).to.be.true;
            expect(resolver.hasRepo('nonexistent')).to.be.false;

            resolver.closeAll();
        });
    });
});
