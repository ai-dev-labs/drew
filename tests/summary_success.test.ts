import { expect } from 'chai';
import { ExtractionEngine } from '../src/engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

describe('Summarization Success', () => {
    let tempDir: string;
    let homeDir: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-test-dir-'));
        homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-test-home-'));
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;

        // Create mock settings
        await fs.ensureDir(path.join(homeDir, '.drew'));
        await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
            provider: 'mock',
            model: 'test-model',
            apiKey: 'test-key'
        });
    });

    afterEach(async () => {
        await fs.remove(tempDir);
        await fs.remove(homeDir);
        process.env.HOME = originalHome;
    });

    it('should generate summaries for new nodes', async () => {
        const engine = new ExtractionEngine();
        const rsPath = path.join(tempDir, 'test.rs');
        await fs.writeFile(rsPath, 'fn my_func() {}');

        const specMap = await engine.extractAll(tempDir);
        const node = specMap.nodes['test.rs:my_func'];
        expect(node).to.exist;
        expect(node.summary).to.contain('Summary for: fn my_func() {}');
    });

    it('should reuse existing summaries if checksum hasn\'t changed', async () => {
        const engine = new ExtractionEngine();
        const rsPath = path.join(tempDir, 'test.rs');
        await fs.writeFile(rsPath, 'fn my_func() {}');

        // Initial extraction
        const specMap1 = await engine.extractAll(tempDir);
        const node1 = specMap1.nodes['test.rs:my_func'];
        node1.summary = 'PREVIOUS_SUMMARY';

        // Second extraction with existing map
        const specMap2 = await engine.extractAll(tempDir, specMap1);
        const node2 = specMap2.nodes['test.rs:my_func'];
        expect(node2.summary).to.equal('PREVIOUS_SUMMARY');
    });

    it('should regenerate summary if checksum changed', async () => {
        const engine = new ExtractionEngine();
        const rsPath = path.join(tempDir, 'test.rs');
        await fs.writeFile(rsPath, 'fn my_func() {}');

        // Initial extraction
        const specMap1 = await engine.extractAll(tempDir);
        const node1 = specMap1.nodes['test.rs:my_func'];
        node1.summary = 'PREVIOUS_SUMMARY';

        // Change the file
        await fs.writeFile(rsPath, 'fn my_func() { println!("changed"); }');

        // Second extraction
        const specMap2 = await engine.extractAll(tempDir, specMap1);
        const node2 = specMap2.nodes['test.rs:my_func'];
        expect(node2.summary).to.not.equal('PREVIOUS_SUMMARY');
        expect(node2.summary).to.contain('Summary for: fn my_func() { print');
    });
});
