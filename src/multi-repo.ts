import * as path from 'path';
import * as fs from 'fs-extra';
import { DrewVectorStore, SearchResult } from './vectorstore';
import { EmbeddingProvider } from './embeddings';

export interface RepoInfo {
    name: string;
    rootPath: string;
    dataPath: string;
    specMapPath: string;
}

export interface MultiRepoSearchResult extends SearchResult {
    repo: string;
}

export interface MultiRepoGetResult {
    repo: string;
    result: SearchResult;
}

export class MultiRepoResolver {
    private stores: Map<string, DrewVectorStore> = new Map();
    private cwdPath: string;

    constructor(cwdPath: string) {
        this.cwdPath = path.resolve(cwdPath);
    }

    private static readonly SKIP_DIRS = new Set([
        'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
        '.drew', '.next', '.cache', 'coverage', 'target', '__pycache__',
    ]);

    private static readonly MAX_SCAN_DEPTH = 4;

    async discoverSiblingRepos(): Promise<RepoInfo[]> {
        const repos: RepoInfo[] = [];
        const seen = new Set<string>();

        // Check if cwd itself has an index
        const cwdDataPath = path.join(this.cwdPath, '.drew', '.data');
        if (await fs.pathExists(cwdDataPath)) {
            const name = path.basename(this.cwdPath);
            seen.add(this.cwdPath);
            repos.push({
                name,
                rootPath: this.cwdPath,
                dataPath: cwdDataPath,
                specMapPath: path.join(this.cwdPath, '.drew', 'spec-map.json'),
            });
        }

        // Recursively search child directories for indexed repos
        await this.scanDirForRepos(this.cwdPath, repos, seen);

        return repos;
    }

    private async scanDirForRepos(
        dir: string,
        repos: RepoInfo[],
        seen: Set<string>,
        depth = 0,
    ): Promise<void> {
        if (depth >= MultiRepoResolver.MAX_SCAN_DEPTH) return;

        let entries: string[];
        try {
            entries = await fs.readdir(dir);
        } catch {
            return;
        }

        for (const entry of entries) {
            if (MultiRepoResolver.SKIP_DIRS.has(entry)) continue;

            const entryPath = path.join(dir, entry);
            if (seen.has(entryPath)) continue;

            let stat;
            try {
                stat = await fs.stat(entryPath);
            } catch {
                continue;
            }
            if (!stat.isDirectory()) continue;

            const dataPath = path.join(entryPath, '.drew', '.data');
            if (await fs.pathExists(dataPath)) {
                seen.add(entryPath);
                repos.push({
                    name: entry,
                    rootPath: entryPath,
                    dataPath,
                    specMapPath: path.join(entryPath, '.drew', 'spec-map.json'),
                });
            } else {
                // No index here — recurse deeper to find nested repos
                await this.scanDirForRepos(entryPath, repos, seen, depth + 1);
            }
        }
    }

    async openAll(): Promise<{ opened: string[]; failed: string[] }> {
        const repos = await this.discoverSiblingRepos();
        const opened: string[] = [];
        const failed: string[] = [];

        for (const repo of repos) {
            try {
                const embedder = await this.createEmbedder();
                const store = new DrewVectorStore(repo.rootPath, embedder);
                if (await store.open()) {
                    this.stores.set(repo.name, store);
                    opened.push(repo.name);
                } else {
                    failed.push(repo.name);
                }
            } catch {
                failed.push(repo.name);
            }
        }

        return { opened, failed };
    }

    async searchAll(
        query: string,
        limit: number,
        typeFilter?: 'node' | 'spec',
    ): Promise<MultiRepoSearchResult[]> {
        const promises = Array.from(this.stores.entries()).map(
            async ([name, store]): Promise<MultiRepoSearchResult[]> => {
                try {
                    const results = await store.search(query, limit, typeFilter);
                    return results.map(r => ({ ...r, repo: name }));
                } catch {
                    return [];
                }
            },
        );

        const allResults = (await Promise.all(promises)).flat();
        allResults.sort((a, b) => b.score - a.score);
        return allResults.slice(0, limit);
    }

    async searchRepo(
        repoName: string,
        query: string,
        limit: number,
        typeFilter?: 'node' | 'spec',
    ): Promise<MultiRepoSearchResult[]> {
        const store = this.stores.get(repoName);
        if (!store) {
            const available = this.getRepoNames().join(', ');
            throw new Error(
                `Repository '${repoName}' not found. Available: ${available}`,
            );
        }

        const results = await store.search(query, limit, typeFilter);
        return results.map(r => ({ ...r, repo: repoName }));
    }

    async getAll(id: string): Promise<MultiRepoGetResult[]> {
        const results: MultiRepoGetResult[] = [];

        const promises = Array.from(this.stores.entries()).map(
            async ([name, store]) => {
                try {
                    const result = await store.get(id);
                    if (result) {
                        results.push({ repo: name, result });
                    }
                } catch {
                    // Skip repos that error
                }
            },
        );

        await Promise.all(promises);
        return results;
    }

    async getFromRepo(
        repoName: string,
        id: string,
    ): Promise<MultiRepoGetResult | null> {
        const store = this.stores.get(repoName);
        if (!store) {
            const available = this.getRepoNames().join(', ');
            throw new Error(
                `Repository '${repoName}' not found. Available: ${available}`,
            );
        }

        const result = await store.get(id);
        if (!result) return null;
        return { repo: repoName, result };
    }

    async deleteFromRepo(repoName: string, id: string): Promise<boolean> {
        const store = this.stores.get(repoName);
        if (!store) {
            const available = this.getRepoNames().join(', ');
            throw new Error(
                `Repository '${repoName}' not found. Available: ${available}`,
            );
        }

        return store.delete(id);
    }

    closeAll(): void {
        for (const store of this.stores.values()) {
            store.close();
        }
        this.stores.clear();
    }

    getRepoNames(): string[] {
        return Array.from(this.stores.keys());
    }

    hasRepo(name: string): boolean {
        return this.stores.has(name);
    }

    private async createEmbedder(): Promise<EmbeddingProvider> {
        const { createEmbeddingProvider } = require('./embeddings');
        return createEmbeddingProvider();
    }
}
