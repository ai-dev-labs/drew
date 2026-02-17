#!/usr/bin/env node
import { Command } from 'commander';
import { ExtractionEngine, saveSpecMap, CodeGraphNode, Requirement } from './engine';
import { DrewVectorStore, SearchResult, IndexResult } from './vectorstore';
import { MultiRepoResolver, MultiRepoSearchResult, MultiRepoGetResult } from './multi-repo';
import { createEmbeddingProvider } from './embeddings';
import { loadSettings } from './summarizer';
import * as path from 'path';
import * as fs from 'fs-extra';

const program = new Command();

program
    .name('drew')
    .description('Code-Graph Extraction Engine')
    .version('1.0.0');

program
    .command('extract')
    .description('Extract symbols from source code')
    .argument('<path>', 'Path to the directory to scan')
    .option('-c, --commit <sha>', 'Commit SHA for incremental extraction')
    .action(async (dirPath, options) => {
        const absolutePath = path.resolve(dirPath);
        const engine = new ExtractionEngine();
        
        console.log(`Scanning directory: ${absolutePath}`);

        let existingMap;
        const specMapPath = path.join(absolutePath, '.drew', 'spec-map.json');
        if (await fs.pathExists(specMapPath)) {
            try {
                existingMap = await fs.readJson(specMapPath);
            } catch (err) {
                console.warn(`Warning: Failed to load existing spec-map.json: ${err}`);
            }
        }

        try {
            const specMap = await engine.extractAll(absolutePath, existingMap);

            if (options.commit) {
                console.log(`Incremental extraction for commit: ${options.commit}`);
                // TODO: Implement incremental logic
            }

            await saveSpecMap(absolutePath, specMap);
            console.log(`Extracted ${Object.keys(specMap.nodes).length} nodes to .drew/spec-map.json`);
        } catch (err: any) {
            if (err.message.includes('Quota exceeded') || err.message.includes('429')) {
                console.error(`Error: LLM Rate limit exceeded. Please wait a moment and try again.`);
            } else {
                console.error(`Error: ${err.message}`);
            }
            process.exit(1);
        }
    });

// --- Vector search commands ---

program
    .command('index')
    .description('Index spec-map.json into the vector store')
    .argument('[path]', 'Path to the project directory', '.')
    .option('--reindex', 'Delete existing index and rebuild from scratch')
    .option('--all', 'Index all sibling repositories')
    .action(async (dirPath, options) => {
        const absolutePath = path.resolve(dirPath);

        if (options.all) {
            try {
                const resolver = new MultiRepoResolver(absolutePath);
                const repos = await resolver.discoverSiblingRepos();

                if (repos.length === 0) {
                    console.error('No indexed repositories found in parent directory.');
                    process.exit(1);
                }

                let indexingConcurrency: number | undefined;
                try {
                    const settings = await loadSettings();
                    indexingConcurrency = settings.indexing_concurrency;
                } catch {
                    // Settings may not exist for indexing-only use
                }

                for (const repo of repos) {
                    if (!await fs.pathExists(repo.specMapPath)) {
                        console.log(`Skipping ${repo.name}: no spec-map.json`);
                        continue;
                    }

                    try {
                        const specMap = await fs.readJson(repo.specMapPath);
                        const embedder = await createEmbeddingProvider();
                        const store = new DrewVectorStore(repo.rootPath, embedder);

                        await store.create(!!options.reindex);
                        const result = await store.indexAll(specMap, indexingConcurrency);
                        store.close();

                        console.log(`[${repo.name}] Indexed ${result.nodes + result.specs} items (${result.added} added, ${result.updated} updated, ${result.removed} removed, ${result.unchanged} unchanged)`);
                    } catch (err: any) {
                        console.error(`Warning: Could not index '${repo.name}': ${err.message}`);
                    }
                }
            } catch (err: any) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
            }
            return;
        }

        const specMapPath = path.join(absolutePath, '.drew', 'spec-map.json');

        if (!await fs.pathExists(specMapPath)) {
            console.error('No spec-map.json found. Run `drew extract` first.');
            process.exit(1);
        }

        try {
            let indexingConcurrency: number | undefined;
            try {
                const settings = await loadSettings();
                indexingConcurrency = settings.indexing_concurrency;
            } catch {
                // Settings may not exist for indexing-only use
            }

            const specMap = await fs.readJson(specMapPath);
            const embedder = await createEmbeddingProvider();
            const store = new DrewVectorStore(absolutePath, embedder);

            await store.create(!!options.reindex);
            const result = await store.indexAll(specMap, indexingConcurrency);
            store.close();

            console.log(`Indexed ${result.nodes + result.specs} items (${result.added} added, ${result.updated} updated, ${result.removed} removed, ${result.unchanged} unchanged)`);
        } catch (err: any) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('search')
    .description('Semantic search over indexed documents')
    .argument('<query>', 'Search query')
    .option('--limit <n>', 'Maximum results to return', '10')
    .option('--json', 'Output as JSON')
    .option('--type <type>', 'Filter by type: node or spec')
    .option('--repo <name>', 'Search a specific repository')
    .action(async (query, options) => {
        const absolutePath = path.resolve('.');
        const limit = parseInt(options.limit, 10) || 10;
        const typeFilter = options.type as 'node' | 'spec' | undefined;

        try {
            const resolver = new MultiRepoResolver(absolutePath);
            const { opened, failed } = await resolver.openAll();

            if (opened.length > 0) {
                for (const name of failed) {
                    console.error(`Warning: Could not open index for '${name}'`);
                }

                let results: MultiRepoSearchResult[];
                if (options.repo) {
                    if (!resolver.hasRepo(options.repo)) {
                        const available = resolver.getRepoNames().join(', ');
                        console.error(`Repository '${options.repo}' not found. Available: ${available}`);
                        resolver.closeAll();
                        process.exit(1);
                    }
                    results = await resolver.searchRepo(options.repo, query, limit, typeFilter);
                } else {
                    results = await resolver.searchAll(query, limit, typeFilter);
                }

                resolver.closeAll();

                if (options.json) {
                    const repos = [...new Set(results.map(r => r.repo))];
                    console.log(JSON.stringify({ query, repos, results }, null, 2));
                } else {
                    printPrettyMultiRepoResults(query, results);
                }
                return;
            }

            resolver.closeAll();
        } catch {
            // Multi-repo discovery failed, fall through to single-repo search
        }

        // Fall back to single-repo search (cwd has its own index)
        try {
            const embedder = await createEmbeddingProvider();
            const store = new DrewVectorStore(absolutePath, embedder);

            if (!await store.open()) {
                console.error('No index found. Run `drew index` first.');
                process.exit(1);
            }

            const results = await store.search(query, limit, typeFilter);
            store.close();

            if (options.json) {
                console.log(JSON.stringify({ query, results }, null, 2));
            } else {
                printPrettyResults(query, results);
            }
        } catch (err: any) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('get')
    .description('Get a document by ID from the vector store')
    .argument('<id>', 'Document ID')
    .option('--json', 'Output as JSON')
    .option('--all', 'Search all sibling repositories for the ID')
    .option('--repo <name>', 'Get from a specific sibling repository')
    .action(async (id, options) => {
        if (options.all && options.repo) {
            console.error('Error: --all and --repo cannot be used together');
            process.exit(1);
        }

        const absolutePath = path.resolve('.');

        if (options.all || options.repo) {
            try {
                const resolver = new MultiRepoResolver(absolutePath);
                const { opened, failed } = await resolver.openAll();

                if (opened.length === 0) {
                    console.error('Error: No repositories could be opened.');
                    resolver.closeAll();
                    process.exit(1);
                }

                for (const name of failed) {
                    console.error(`Warning: Could not open index for '${name}'`);
                }

                if (options.repo) {
                    if (!resolver.hasRepo(options.repo)) {
                        const available = resolver.getRepoNames().join(', ');
                        console.error(`Repository '${options.repo}' not found. Available: ${available}`);
                        resolver.closeAll();
                        process.exit(1);
                    }
                    const result = await resolver.getFromRepo(options.repo, id);
                    resolver.closeAll();

                    if (!result) {
                        console.error(`Document '${id}' not found in '${options.repo}'.`);
                        process.exit(1);
                    }

                    if (options.json) {
                        console.log(JSON.stringify(result, null, 2));
                    } else {
                        console.log(`[${result.repo}]`);
                        printPrettyResult(result.result);
                    }
                } else {
                    const results = await resolver.getAll(id);
                    resolver.closeAll();

                    if (results.length === 0) {
                        console.error(`Document '${id}' not found in any repository.`);
                        process.exit(1);
                    }

                    if (options.json) {
                        console.log(JSON.stringify(results, null, 2));
                    } else {
                        for (const r of results) {
                            console.log(`[${r.repo}]`);
                            printPrettyResult(r.result);
                        }
                    }
                }
            } catch (err: any) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
            }
            return;
        }

        try {
            const embedder = await createEmbeddingProvider();
            const store = new DrewVectorStore(absolutePath, embedder);

            if (!await store.open()) {
                console.error('No index found. Run `drew index` first.');
                process.exit(1);
            }

            const result = await store.get(id);
            store.close();

            if (!result) {
                console.error(`Document '${id}' not found.`);
                process.exit(1);
            }

            if (options.json) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                printPrettyResult(result);
            }
        } catch (err: any) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('delete')
    .description('Delete a document by ID from the vector store')
    .argument('<id>', 'Document ID')
    .option('--repo <name>', 'Delete from a specific sibling repository')
    .action(async (id, options) => {
        const absolutePath = path.resolve('.');

        if (options.repo) {
            try {
                const resolver = new MultiRepoResolver(absolutePath);
                const { opened, failed } = await resolver.openAll();

                if (opened.length === 0) {
                    console.error('Error: No repositories could be opened.');
                    resolver.closeAll();
                    process.exit(1);
                }

                if (!resolver.hasRepo(options.repo)) {
                    const available = resolver.getRepoNames().join(', ');
                    console.error(`Repository '${options.repo}' not found. Available: ${available}`);
                    resolver.closeAll();
                    process.exit(1);
                }

                const deleted = await resolver.deleteFromRepo(options.repo, id);
                resolver.closeAll();

                if (!deleted) {
                    console.error(`Document '${id}' not found in '${options.repo}'.`);
                    process.exit(1);
                }

                console.log(`Deleted '${id}' from '${options.repo}'`);
            } catch (err: any) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
            }
            return;
        }

        try {
            const embedder = await createEmbeddingProvider();
            const store = new DrewVectorStore(absolutePath, embedder);

            if (!await store.open()) {
                console.error('No index found. Run `drew index` first.');
                process.exit(1);
            }

            const deleted = await store.delete(id);
            store.close();

            if (!deleted) {
                console.error(`Document '${id}' not found.`);
                process.exit(1);
            }

            console.log(`Deleted '${id}'`);
        } catch (err: any) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('instructions')
    .description('Print AI agent instructions for using drew to explore code')
    .action(() => {
        console.log(AGENT_INSTRUCTIONS);
    });

// --- Pretty-print helpers ---

function printPrettyResults(query: string, results: SearchResult[]): void {
    if (results.length === 0) {
        console.log(`No results for "${query}"`);
        return;
    }

    console.log(`Results for "${query}" (${results.length}):`);
    for (const r of results) {
        printPrettyResult(r);
    }
}

function printPrettyResult(r: SearchResult): void {
    const scoreStr = r.score > 0 ? ` (${r.score.toFixed(2)})` : '';

    if (r.type === 'node') {
        const node = r.data as CodeGraphNode;
        console.log(`  [node] ${r.id}${scoreStr}`);
        console.log(`    Kind: ${node.kind}`);
        console.log(`    Lines: ${node.start_line}-${node.end_line}`);
        if (node.summary) console.log(`    Summary: ${node.summary}`);
    } else {
        const spec = r.data as Requirement;
        console.log(`  [spec] ${r.id}${scoreStr}`);
        console.log(`    ${spec.description}`);
        if (spec.acceptance_criteria && spec.acceptance_criteria.length > 0) {
            console.log(`    Acceptance Criteria:`);
            for (const ac of spec.acceptance_criteria) {
                console.log(`      - ${ac}`);
            }
        }
        if (r.linkedNodes && r.linkedNodes.length > 0) {
            console.log(`    Linked Nodes:`);
            for (const node of r.linkedNodes) {
                console.log(`      - ${node.id}`);
                console.log(`        Kind: ${node.kind}`);
                console.log(`        Lines: ${node.start_line}-${node.end_line}`);
                if (node.summary) console.log(`        Summary: ${node.summary}`);
            }
        }
    }
}

function printPrettyMultiRepoResults(query: string, results: MultiRepoSearchResult[]): void {
    if (results.length === 0) {
        console.log(`No results for "${query}"`);
        return;
    }

    const repos = [...new Set(results.map(r => r.repo))];
    console.log(`Results for "${query}" (${results.length} results from ${repos.length} repo${repos.length === 1 ? '' : 's'}):`);
    for (const r of results) {
        printPrettyMultiRepoResult(r);
    }
}

function printPrettyMultiRepoResult(r: MultiRepoSearchResult): void {
    const scoreStr = r.score > 0 ? ` (${r.score.toFixed(2)})` : '';

    if (r.type === 'node') {
        const node = r.data as CodeGraphNode;
        console.log(`  [node] ${r.id}${scoreStr} [${r.repo}]`);
        console.log(`    Kind: ${node.kind}`);
        console.log(`    Lines: ${node.start_line}-${node.end_line}`);
        if (node.summary) console.log(`    Summary: ${node.summary}`);
    } else {
        const spec = r.data as Requirement;
        console.log(`  [spec] ${r.id}${scoreStr} [${r.repo}]`);
        console.log(`    ${spec.description}`);
        if (spec.acceptance_criteria && spec.acceptance_criteria.length > 0) {
            console.log(`    Acceptance Criteria:`);
            for (const ac of spec.acceptance_criteria) {
                console.log(`      - ${ac}`);
            }
        }
        if (r.linkedNodes && r.linkedNodes.length > 0) {
            console.log(`    Linked Nodes:`);
            for (const node of r.linkedNodes) {
                console.log(`      - ${node.id}`);
                console.log(`        Kind: ${node.kind}`);
                console.log(`        Lines: ${node.start_line}-${node.end_line}`);
                if (node.summary) console.log(`        Summary: ${node.summary}`);
            }
        }
    }
}

// --- Agent instructions ---

const AGENT_INSTRUCTIONS = `# Drew — AI Agent Code Exploration Guide

You have access to \`drew\`, a semantic code exploration tool. drew maintains an
indexed graph of every code symbol (function, class, interface, etc.) and its
formal EARS specification, searchable by natural language.

## CRITICAL RULE

Before writing or modifying ANY code or tests, you MUST use drew to explore the
codebase first. Do not guess at file locations, function signatures, or system
behavior. Search, read, then act.

## Quick Reference

    drew search <query>                   # Semantic search (default 10 results)
    drew search <query> --limit 5         # Fewer results
    drew search <query> --type node       # Only code symbols
    drew search <query> --type spec       # Only specifications
    drew search <query> --json            # Machine-readable output
    drew search <query> --all             # Search all sibling repos
    drew search <query> --repo <name>     # Search a specific sibling repo
    drew get <id>                         # Full document by ID
    drew get <id> --json                  # Machine-readable output
    drew get <id> --all                   # Get from all sibling repos
    drew get <id> --repo <name>           # Get from a specific sibling repo
    drew index                            # Re-index after extraction
    drew index --reindex                  # Full rebuild
    drew index --all                      # Index all sibling repos

## Workflow

### 1. Understand the task

Read the task description. Identify the key concepts, components, and behaviors
involved. Formulate 2-3 search queries that target different aspects of the task.

### 2. Search for relevant code

Run drew search with natural language queries describing what you need to find.
Start broad, then narrow.

    drew search "error handling in extraction"
    drew search "how specs are generated from summaries"
    drew search "file traversal and ignore rules"

Each result includes:
- [node] results: code symbol ID, kind (function, class, etc.), and AI summary
- [spec] results: formal requirement, acceptance criteria, AND the full linked
  code nodes — so you get the complete picture in one call

### 3. Get full details

When a search result looks relevant, use drew get with its ID to retrieve the
full document. For specifications, this also returns every linked code node.

    drew get "REQ-EXTRACTALL-1"
    drew get "src/engine.ts:extractAll"

The ID format for code nodes is \`path:SymbolName\`. For specs it is \`REQ-*\`.

### 4. Build your mental model

Before touching code, you should be able to answer:
- Which files and symbols are involved?
- What are the formal requirements and acceptance criteria?
- What are the relationships between components?
- Where are the boundaries of the change?

### 5. Then write code

Only after steps 1-4 should you write or modify code. Your changes should
align with the existing patterns, naming conventions, and architecture that
drew revealed.

## Search Strategy Tips

- Use domain language from the codebase, not generic terms
- Search for behavior ("validate user input") not implementation ("regex check")
- Use --type spec to find requirements and acceptance criteria for a feature
- Use --type node to find the actual code symbols implementing something
- If search returns too many results, add specificity to your query
- If search returns too few, try synonyms or broader descriptions
- Run multiple searches from different angles — the first query is rarely the best

## Understanding Results

### Code Nodes

A code node represents a single extracted symbol:

    [node] src/engine.ts:extractAll (0.87)
      Kind: function_declaration
      Summary: Main extraction pipeline that walks the project directory...

The ID (src/engine.ts:extractAll) tells you the file and symbol name. The kind
tells you what it is. The summary is an AI-generated description of what it does.

### Specifications

A specification is a formal EARS requirement derived from code:

    [spec] REQ-EXTRACTALL-1 (0.82)
      Description: The system SHALL extract all code symbols from supported files.
      Acceptance Criteria:
        - The extraction SHALL include functions, classes, and interfaces.
        - The extraction SHALL skip files matching .drewignore patterns.
      Linked Nodes:
        - src/engine.ts:extractAll
          Kind: function_declaration
          Summary: Main extraction pipeline that walks the project directory...

Specs include their full linked code nodes, so you get the requirement AND its
implementation in a single response.

## JSON Output

Use --json when you need to parse results programmatically:

    drew search "authentication" --json
    drew get "REQ-AUTH-1" --json

The JSON schema for search results:

    {
      "query": "...",
      "results": [
        {
          "id": "src/file.ts:Symbol",
          "type": "node" | "spec",
          "score": 0.87,
          "data": { /* full CodeGraphNode or Requirement */ },
          "linkedNodes": [ /* full CodeGraphNodes, for specs only */ ]
        }
      ]
    }

## Multi-Repository Search

When working across multiple related repos in a workspace (e.g. ~/workplace/),
use --all to search all sibling repos that have been indexed with drew:

    drew search "authentication" --all       # Search all siblings
    drew search "auth" --repo my-service     # Search specific sibling
    drew get "src/auth.ts:login" --all       # Find ID across all repos
    drew index --all                         # Index all siblings

Multi-repo results include a [repo-name] tag showing which repo each result
came from. Results are merged and ranked by relevance score across all repos.

JSON output includes a top-level "repos" array listing all repos that
contributed results.

## When the Index is Stale

If the codebase has been modified since the last extraction, the index may be
out of date. Run:

    drew extract .        # Re-extract symbols and specs
    drew index            # Re-index into the vector store

Or for a clean rebuild:

    drew index --reindex
`;

program.parseAsync(process.argv).catch(err => {
    console.error(err);
    process.exit(1);
});
