import { expect } from 'chai';
import { ExtractionEngine } from '../src/engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { AISummarizer } from '../src/summarizer';

describe('Incremental Summarization', () => {
    let tempDir: string;
    let homeDir: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-incremental-test-'));
        homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-incremental-home-'));
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

    it('should only summarize changed or new nodes', async () => {
        const engine = new ExtractionEngine();
        
        const file1 = path.join(tempDir, 'file1.rs');
        const file2 = path.join(tempDir, 'file2.rs');
        
        await fs.writeFile(file1, 'fn func1() {}');
        await fs.writeFile(file2, 'fn func2() {}');

        // First run: Extract both
        const specMap1 = await engine.extractAll(tempDir);
        expect(Object.keys(specMap1.nodes)).to.have.lengthOf(2);
        const originalSummary1 = specMap1.nodes['file1.rs:func1'].summary;
        const originalSummary2 = specMap1.nodes['file2.rs:func2'].summary;

        // Second run: Nothing changed, pass existing map
        const specMap2 = await engine.extractAll(tempDir, specMap1);
        expect(specMap2.nodes['file1.rs:func1'].summary).to.equal(originalSummary1);
        expect(specMap2.nodes['file2.rs:func2'].summary).to.equal(originalSummary2);

        // Third run: change file1.rs
        await fs.writeFile(file1, 'fn func1() { println!("changed"); }');
        const specMap3 = await engine.extractAll(tempDir, specMap2);
        
        expect(specMap3.nodes['file1.rs:func1'].summary).to.not.equal(originalSummary1);
        expect(specMap3.nodes['file1.rs:func1'].summary).to.contain('Summary for: fn func1() { print');
        expect(specMap3.nodes['file2.rs:func2'].summary).to.equal(originalSummary2);
    });
});
