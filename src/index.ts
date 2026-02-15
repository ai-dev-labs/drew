#!/usr/bin/env node
import { Command } from 'commander';
import { ExtractionEngine, saveSpecMap } from './engine';
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

program.parseAsync(process.argv).catch(err => {
    console.error(err);
    process.exit(1);
});
