import { expect } from 'chai';
import { ExtractionEngine } from '../src/engine';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

describe('ExtractionEngine', () => {
    let engine: ExtractionEngine;
    let tempDir: string;

    beforeEach(async () => {
        engine = new ExtractionEngine();
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-test-'));
    });

    afterEach(async () => {
        await fs.remove(tempDir);
    });

    it('should extract symbols from a rust file', async () => {
        const rsPath = path.join(tempDir, 'test.rs');
        await fs.writeFile(rsPath, `
            fn my_function() {}
            struct MyStruct {}
        `);

        const nodes = await engine.extractFile(tempDir, rsPath);
        
        const names = nodes.map(n => n.name);
        expect(names).to.include('my_function');
        expect(names).to.include('MyStruct');

        const functionNode = nodes.find(n => n.name === 'my_function');
        expect(functionNode?.kind).to.equal('function_item');

        const structNode = nodes.find(n => n.name === 'MyStruct');
        expect(structNode?.kind).to.equal('struct_item');
    });
});
