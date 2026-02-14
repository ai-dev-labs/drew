import { expect } from 'chai';
import { ExtractionEngine } from '../src/engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

describe('Summarization Failure', () => {
    let tempDir: string;
    let homeDir: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-test-dir-'));
        homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-test-home-'));
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;
    });

    afterEach(async () => {
        await fs.remove(tempDir);
        await fs.remove(homeDir);
        process.env.HOME = originalHome;
    });

    it('should report an error if settings.json is missing', async () => {
        const engine = new ExtractionEngine();
        const rsPath = path.join(tempDir, 'test.rs');
        await fs.writeFile(rsPath, 'fn main() {}');

        try {
            await engine.extractAll(tempDir);
            expect.fail('Should have thrown an error');
        } catch (err: any) {
            expect(err.message).to.contain('Settings file not found');
        }
    });
});
