import { expect } from 'chai';
import { SimpleEmbeddingProvider, TensorFlowEmbeddingProvider, EmbeddingProvider } from '../src/embeddings';

describe('Embeddings', () => {
    describe('SimpleEmbeddingProvider', () => {
        let provider: SimpleEmbeddingProvider;

        beforeEach(() => {
            provider = new SimpleEmbeddingProvider();
        });

        it('should produce 512-dimensional vectors', async () => {
            const vector = await provider.embed('hello world');
            expect(vector).to.have.lengthOf(512);
        });

        it('should produce normalized unit vectors', async () => {
            const vector = await provider.embed('some text to embed');
            const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
            expect(magnitude).to.be.closeTo(1.0, 0.001);
        });

        it('should produce different vectors for different text', async () => {
            const v1 = await provider.embed('function extractAll');
            const v2 = await provider.embed('database connection pool');
            expect(v1).to.not.deep.equal(v2);
        });

        it('should produce similar vectors for similar text', async () => {
            const v1 = await provider.embed('extract symbols from code');
            const v2 = await provider.embed('extract symbols from source');
            // Cosine similarity should be higher for similar text
            const dot = v1.reduce((sum, a, i) => sum + a * v2[i], 0);
            expect(dot).to.be.greaterThan(0.5);
        });

        it('should report dimension as 512', () => {
            expect(provider.dimension).to.equal(512);
        });

        it('should initialize without error', async () => {
            await provider.initialize();
        });
    });

    describe('TensorFlowEmbeddingProvider', () => {
        let provider: TensorFlowEmbeddingProvider;

        before(async function() {
            this.timeout(30000);
            provider = new TensorFlowEmbeddingProvider();
            try {
                await provider.initialize();
            } catch {
                // Skip TF.js tests if model not available
                this.skip();
            }
        });

        it('should produce 512-dimensional vectors', async function() {
            this.timeout(10000);
            const vector = await provider.embed('hello world');
            expect(vector).to.have.lengthOf(512);
        });

        it('should produce normalized unit vectors', async function() {
            this.timeout(10000);
            const vector = await provider.embed('some text to embed');
            const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
            expect(magnitude).to.be.closeTo(1.0, 0.05);
        });

        it('should produce different vectors for different text', async function() {
            this.timeout(10000);
            const v1 = await provider.embed('function extractAll');
            const v2 = await provider.embed('database connection pool');
            expect(v1).to.not.deep.equal(v2);
        });

        it('should report dimension as 512', () => {
            expect(provider.dimension).to.equal(512);
        });
    });
});
