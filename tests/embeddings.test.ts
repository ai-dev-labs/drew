import { expect } from 'chai';
import { SimpleEmbeddingProvider, EmbeddingProvider } from '../src/embeddings';

describe('EmbeddingProvider - embedBatch', () => {
    describe('SimpleEmbeddingProvider', () => {
        let provider: SimpleEmbeddingProvider;

        beforeEach(async () => {
            provider = new SimpleEmbeddingProvider();
            await provider.initialize();
        });

        it('should have embedBatch method', () => {
            expect(provider.embedBatch).to.be.a('function');
        });

        it('should return correct number of vectors for batch', async () => {
            const texts = ['hello world', 'foo bar baz', 'test input', 'another example', 'fifth item'];
            const results = await provider.embedBatch(texts);
            expect(results).to.have.length(5);
        });

        it('should return vectors with correct dimensions', async () => {
            const texts = ['hello world', 'test input'];
            const results = await provider.embedBatch(texts);
            for (const vec of results) {
                expect(vec).to.have.length(provider.dimension);
            }
        });

        it('should match sequential embed results', async () => {
            const texts = ['hello world', 'semantic search', 'code analysis'];
            const batchResults = await provider.embedBatch(texts);
            const sequentialResults = await Promise.all(texts.map(t => provider.embed(t)));

            for (let i = 0; i < texts.length; i++) {
                expect(batchResults[i]).to.deep.equal(sequentialResults[i]);
            }
        });

        it('should handle single-item batch', async () => {
            const results = await provider.embedBatch(['only one']);
            expect(results).to.have.length(1);
            expect(results[0]).to.have.length(provider.dimension);
        });

        it('should handle empty batch', async () => {
            const results = await provider.embedBatch([]);
            expect(results).to.have.length(0);
        });
    });

    describe('EmbeddingProvider interface - embedBatch fallback', () => {
        it('should work when embedBatch is not defined on a provider', async () => {
            // Simulates a provider that does not implement embedBatch
            const minimalProvider: EmbeddingProvider = {
                dimension: 4,
                async initialize() {},
                async embed(text: string) {
                    return [text.length, 0, 0, 0];
                },
            };

            expect(minimalProvider.embedBatch).to.be.undefined;

            // Fallback logic: if embedBatch is missing, fall back to sequential
            const texts = ['a', 'bb', 'ccc'];
            let results: number[][];
            if (minimalProvider.embedBatch) {
                results = await minimalProvider.embedBatch(texts);
            } else {
                results = await Promise.all(texts.map(t => minimalProvider.embed(t)));
            }

            expect(results).to.have.length(3);
            expect(results[0][0]).to.equal(1);
            expect(results[1][0]).to.equal(2);
            expect(results[2][0]).to.equal(3);
        });
    });
});
