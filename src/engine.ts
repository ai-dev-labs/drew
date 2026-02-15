import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import Typescript from 'tree-sitter-typescript';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cliProgress from 'cli-progress';
import ignore from 'ignore';

import { Summarizer, AISummarizer, loadSettings } from './summarizer';

export interface CodeGraphNode {
    id: string;
    kind: string;
    name: string;
    namespace: string[];
    path: string;
    commit_sha?: string;
    start_byte: number;
    end_byte: number;
    start_line: number;
    end_line: number;
    checksum: string;
    summary?: string;
}

export interface Requirement {
    id: string;
    description: string;
    acceptance_criteria: string[];
    node_ids: string[];
    checksum: string;
}

export interface SpecMap {
    nodes: Record<string, CodeGraphNode>;
    specifications?: Record<string, Requirement>;
}

interface LanguageConfig {
    language: any;
    query: Parser.Query;
    extensions: string[];
}

export class ExtractionEngine {
    private parser: Parser;
    private configs: Record<string, LanguageConfig> = {};
    private summarizer?: Summarizer;

    constructor() {
        this.parser = new Parser();
        
        // Setup Rust
        const rustLanguage = Rust as any;
        const rustQuerySource = `
            (function_item name: (identifier) @name) @function
            (struct_item name: (type_identifier) @name) @struct
            (enum_item name: (type_identifier) @name) @enum
            (trait_item name: (type_identifier) @name) @trait
            (mod_item name: (identifier) @name) @module
            (impl_item type: (type_identifier) @name) @impl
        `;
        this.configs['.rs'] = {
            language: rustLanguage,
            query: new Parser.Query(rustLanguage, rustQuerySource),
            extensions: ['.rs']
        };

        // Setup TypeScript
        const tsLanguage = Typescript.typescript as any;
        const tsQuerySource = `
            (function_declaration name: (identifier) @name) @function
            (function_signature name: (identifier) @name) @function
            (method_definition name: (property_identifier) @name) @method
            (class_declaration name: (type_identifier) @name) @class
            (interface_declaration name: (type_identifier) @name) @interface
            (type_alias_declaration name: (type_identifier) @name) @type
            (enum_declaration name: (identifier) @name) @enum
            (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
            (internal_module name: (identifier) @name) @module
        `;
        this.configs['.ts'] = {
            language: tsLanguage,
            query: new Parser.Query(tsLanguage, tsQuerySource),
            extensions: ['.ts', '.tsx']
        };
        this.configs['.tsx'] = this.configs['.ts'];
    }

    private getConfigForFile(filePath: string): LanguageConfig | undefined {
        const ext = path.extname(filePath);
        return this.configs[ext];
    }

    async extractAll(rootPath: string, existingMap?: SpecMap): Promise<SpecMap> {
        const settings = await loadSettings();
        this.summarizer = new AISummarizer(settings);

        const specMap: SpecMap = { nodes: {} };
        const ig = ignore();
        const drewIgnorePath = path.join(rootPath, '.drewignore');
        if (await fs.pathExists(drewIgnorePath)) {
            ig.add(await fs.readFile(drewIgnorePath, 'utf8'));
        }

        const files: string[] = [];
        const walk = async (dir: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const res = path.resolve(dir, entry.name);
                const relPath = path.relative(rootPath, res);
                if (ig.ignores(relPath)) continue;

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
                    await walk(res);
                } else if (entry.isFile()) {
                    if (this.getConfigForFile(res)) {
                        files.push(res);
                    }
                }
            }
        };

        await walk(rootPath);

        const allNodes: CodeGraphNode[] = [];
        const extractionProgress = new cliProgress.SingleBar({
            format: 'Extracting | {bar} | {percentage}% | {value}/{total} Files',
        }, cliProgress.Presets.shades_classic);
        
        extractionProgress.start(files.length, 0);

        for (const filePath of files) {
            try {
                const sourceCode = await fs.readFile(filePath, 'utf8');
                const nodes = await this.extractFile(rootPath, filePath, sourceCode);
                for (const node of nodes) {
                    const existingNode = existingMap?.nodes[node.id];
                    if (existingNode && existingNode.checksum === node.checksum && existingNode.summary) {
                        node.summary = existingNode.summary;
                    }
                    allNodes.push(node);
                    specMap.nodes[node.id] = node;
                }
            } catch (err) {
                console.warn(`\nWarning: Failed to extract from ${filePath}: ${err}`);
                throw err;
            }
            extractionProgress.increment();
        }
        extractionProgress.stop();

        const nodesToSummarize = allNodes.filter(n => !n.summary);
        if (nodesToSummarize.length > 0 && this.summarizer) {
            const summarizationProgress = new cliProgress.SingleBar({
                format: 'Summarizing | {bar} | {percentage}% | {value}/{total} Symbols',
            }, cliProgress.Presets.shades_classic);
            
            summarizationProgress.start(nodesToSummarize.length, 0);

            const MAX_BATCH_CHARS = 40000;
            const MAX_BATCH_ITEMS = 50;

            let currentBatch: { node: CodeGraphNode, code: string }[] = [];
            let currentBatchChars = 0;

            const processBatch = async (batch: { node: CodeGraphNode, code: string }[]) => {
                const items = batch.map(b => ({ id: b.node.id, code: b.code }));
                try {
                    const batchResults = await this.summarizer!.summarizeBatch(items);
                    for (const b of batch) {
                        if (batchResults[b.node.id]) {
                            b.node.summary = batchResults[b.node.id];
                            specMap.nodes[b.node.id].summary = b.node.summary;
                        }
                    }
                    // Save progress after each batch
                    await saveSpecMap(rootPath, specMap);
                } catch (err) {
                    console.warn(`\nWarning: Batch summarization failed: ${err}`);
                }
                summarizationProgress.increment(batch.length);
            };

            for (const node of nodesToSummarize) {
                const sourceCode = await fs.readFile(path.join(rootPath, node.path), 'utf8');
                const nodeCode = sourceCode.substring(node.start_byte, node.end_byte);

                if (currentBatch.length > 0 && (currentBatchChars + nodeCode.length > MAX_BATCH_CHARS || currentBatch.length >= MAX_BATCH_ITEMS)) {
                    await processBatch(currentBatch);
                    currentBatch = [];
                    currentBatchChars = 0;
                }

                currentBatch.push({ node, code: nodeCode });
                currentBatchChars += nodeCode.length;
            }

            if (currentBatch.length > 0) {
                await processBatch(currentBatch);
            }

            summarizationProgress.stop();
        }

        // --- Specification Layer ---
        const specifications: Record<string, Requirement> = { ...(existingMap?.specifications || {}) };
        const nodesWithSummaries = Object.values(specMap.nodes).filter(n => n.summary);
        
        const calculateRequirementChecksum = (nodeIds: string[]) => {
            const sortedIds = [...nodeIds].sort();
            const composite = sortedIds.map(id => `${id}:${specMap.nodes[id]?.checksum || ''}`).join('|');
            return crypto.createHash('sha256').update(composite).digest('hex');
        };

        // Find nodes that need new or updated specifications
        const validCoveredNodeIds = new Set<string>();
        for (const [id, spec] of Object.entries(specifications)) {
            const currentChecksum = calculateRequirementChecksum(spec.node_ids);
            if (currentChecksum === spec.checksum) {
                for (const nodeId of spec.node_ids) {
                    validCoveredNodeIds.add(nodeId);
                }
            } else {
                delete specifications[id];
            }
        }

        const nodesToSpecialize = nodesWithSummaries.filter(n => !validCoveredNodeIds.has(n.id));

        if (nodesToSpecialize.length > 0 && this.summarizer) {
            console.log(`\nGenerating specifications for ${nodesToSpecialize.length} uncovered/changed nodes...`);
            const specProgress = new cliProgress.SingleBar({
                format: 'Generating Specs | {bar} | {percentage}% | {value}/{total} Nodes',
            }, cliProgress.Presets.shades_classic);

            specProgress.start(nodesToSpecialize.length, 0);

            const MAX_SPEC_BATCH_CHARS = 40000;
            const MAX_SPEC_BATCH_ITEMS = 30; // Still limit items to avoid output token issues

            let currentBatch: CodeGraphNode[] = [];
            let currentBatchChars = 0;

            const processSpecBatch = async (batch: CodeGraphNode[]) => {
                const items = batch.map(n => ({ id: n.id, summary: n.summary! }));
                try {
                    const newSpecs = await this.summarizer!.specialize(items);
                    for (const spec of newSpecs) {
                        specifications[spec.id] = {
                            ...spec,
                            checksum: calculateRequirementChecksum(spec.node_ids)
                        };
                    }
                    // Save progress after each specification batch
                    specMap.specifications = specifications;
                    await saveSpecMap(rootPath, specMap);
                } catch (err) {
                    console.warn(`\nWarning: Specification generation failed: ${err}`);
                    throw err; // Fail the generation as per RFC
                }
                specProgress.increment(batch.length);
            };

            for (const node of nodesToSpecialize) {
                const summaryLen = node.summary?.length || 0;

                if (currentBatch.length > 0 && (currentBatchChars + summaryLen > MAX_SPEC_BATCH_CHARS || currentBatch.length >= MAX_SPEC_BATCH_ITEMS)) {
                    await processSpecBatch(currentBatch);
                    currentBatch = [];
                    currentBatchChars = 0;
                }

                currentBatch.push(node);
                currentBatchChars += summaryLen;
            }

            if (currentBatch.length > 0) {
                await processSpecBatch(currentBatch);
            }
            specProgress.stop();
        }

        specMap.specifications = specifications;
        return specMap;
    }

    async extractFile(rootPath: string, filePath: string, sourceCode?: string): Promise<CodeGraphNode[]> {
        const config = this.getConfigForFile(filePath);
        if (!config) return [];

        this.parser.setLanguage(config.language);
        if (sourceCode === undefined) {
            sourceCode = await fs.readFile(filePath, 'utf8');
        }
        const tree = this.parser.parse(sourceCode);
        const relativePath = path.relative(rootPath, filePath);

        const matches = config.query.matches(tree.rootNode);
        const nodes: CodeGraphNode[] = [];

        for (const match of matches) {
            if (match.captures.length < 2) continue;

            const symbolNode = match.captures[0].node;
            const nameNode = match.captures[1].node;

            const name = sourceCode.substring(nameNode.startIndex, nameNode.endIndex);
            const kind = symbolNode.type;
            const content = sourceCode.substring(symbolNode.startIndex, symbolNode.endIndex);
            const checksum = crypto.createHash('sha256').update(content).digest('hex');

            const id = `${relativePath}:${name}`;

            nodes.push({
                id,
                kind,
                name,
                namespace: [],
                path: relativePath,
                start_byte: symbolNode.startIndex,
                end_byte: symbolNode.endIndex,
                start_line: symbolNode.startPosition.row,
                end_line: symbolNode.endPosition.row,
                checksum,
            });
        }

        return nodes;
    }
}

export async function saveSpecMap(rootPath: string, specMap: SpecMap): Promise<void> {
    const drewDir = path.join(rootPath, '.drew');
    await fs.ensureDir(drewDir);
    const specMapPath = path.join(drewDir, 'spec-map.json');
    await fs.writeJson(specMapPath, specMap, { spaces: 2 });
}
