import * as path from 'path';
import * as fs from 'fs';

export interface EmbeddingProvider {
    initialize(): Promise<void>;
    embed(text: string): Promise<number[]>;
    readonly dimension: number;
}

/**
 * Simple hash-based embedding provider using character n-grams.
 * Pure JavaScript — no native dependencies.
 * Uses locality-sensitive hashing for approximate text similarity.
 */
export class SimpleEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 512;
    private ngramSizes = [2, 3, 4];

    async initialize(): Promise<void> {}

    async embed(text: string): Promise<number[]> {
        const normalized = text.toLowerCase().trim();
        const vector = new Array(this.dimension).fill(0);

        for (const n of this.ngramSizes) {
            for (let i = 0; i <= normalized.length - n; i++) {
                const ngram = normalized.substring(i, i + n);
                const hash = this.hashString(ngram);
                const index = Math.abs(hash) % this.dimension;
                const sign = this.hashString(ngram + 'salt') % 2 === 0 ? 1 : -1;
                vector[index] += sign;
            }
        }

        const words = normalized.split(/\s+/).filter(w => w.length > 0);
        for (const word of words) {
            const hash = this.hashString(word);
            const index = Math.abs(hash) % this.dimension;
            const sign = this.hashString(word + 'word') % 2 === 0 ? 1 : -1;
            vector[index] += sign * 2;
        }

        // L2 normalize to unit vector
        const magnitude = Math.sqrt(vector.reduce((sum: number, val: number) => sum + val * val, 0));
        if (magnitude > 0) {
            for (let i = 0; i < vector.length; i++) {
                vector[i] /= magnitude;
            }
        }

        return vector;
    }

    /** FNV-1a hash */
    private hashString(str: string): number {
        let hash = 2166136261;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        return hash;
    }
}

/**
 * TensorFlow.js Universal Sentence Encoder embedding provider.
 * Uses locally bundled model files — no network access at runtime.
 * Produces 512-dimensional semantic embeddings.
 */
export class TensorFlowEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 512;
    private graphModel: any = null;
    private tokenizer: any = null;
    private tf: any = null;
    private modelPath: string;

    constructor(modelPath?: string) {
        this.modelPath = modelPath || path.join(__dirname, '..', 'models', 'universal-sentence-encoder');
    }

    async initialize(): Promise<void> {
        if (this.graphModel && this.tokenizer) return;

        // Suppress TF.js console noise
        const origLog = console.log;
        const origWarn = console.warn;
        console.log = () => {};
        console.warn = () => {};

        try {
            this.tf = require('@tensorflow/tfjs');
            const tfconv = require('@tensorflow/tfjs-converter');

            this.tf.env().set('PROD', true);

            const modelJsonPath = path.join(this.modelPath, 'model.json');
            const vocabJsonPath = path.join(this.modelPath, 'vocab.json');

            if (!fs.existsSync(modelJsonPath) || !fs.existsSync(vocabJsonPath)) {
                throw new Error(`Model files not found at ${this.modelPath}`);
            }

            this.graphModel = await this.loadModelFromFiles(tfconv, modelJsonPath);

            const vocabulary = JSON.parse(fs.readFileSync(vocabJsonPath, 'utf-8'));
            const use = require('@tensorflow-models/universal-sentence-encoder');
            this.tokenizer = new use.Tokenizer(vocabulary);

            console.log = origLog;
            console.warn = origWarn;
        } catch (error) {
            console.log = origLog;
            console.warn = origWarn;
            throw new Error(`Failed to initialize TensorFlow embedding provider: ${error}`);
        }
    }

    private async loadModelFromFiles(tfconv: any, modelJsonPath: string): Promise<any> {
        const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'));
        const modelDir = path.dirname(modelJsonPath);

        const weightsManifest = modelJson.weightsManifest;
        const weightData: ArrayBuffer[] = [];

        for (const group of weightsManifest) {
            for (const weightPath of group.paths) {
                const fullPath = path.join(modelDir, weightPath);
                const buffer = fs.readFileSync(fullPath);
                weightData.push(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
            }
        }

        const totalLength = weightData.reduce((sum, buf) => sum + buf.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of weightData) {
            combined.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }

        const modelArtifacts = {
            modelTopology: modelJson.modelTopology,
            weightSpecs: weightsManifest.flatMap((g: any) => g.weights),
            weightData: combined.buffer,
        };

        const ioHandler = this.tf.io.fromMemory(modelArtifacts);
        return tfconv.loadGraphModel(ioHandler);
    }

    async embed(text: string): Promise<number[]> {
        if (!this.graphModel || !this.tokenizer) {
            await this.initialize();
        }

        const encoding = this.tokenizer.encode(text);
        const indices = encoding.map((_: number, i: number) => [0, i]);
        const indicesTensor = this.tf.tensor2d(indices, [indices.length, 2], 'int32');
        const valuesTensor = this.tf.tensor1d(encoding, 'int32');

        const embeddings = await this.graphModel.executeAsync({
            indices: indicesTensor,
            values: valuesTensor,
        });

        const data = await embeddings.data();
        indicesTensor.dispose();
        valuesTensor.dispose();
        embeddings.dispose();

        return Array.from(data as Float32Array);
    }
}

/**
 * Create the best available embedding provider.
 * Tries TensorFlow.js first, falls back to simple hash.
 */
export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
    try {
        const provider = new TensorFlowEmbeddingProvider();
        await provider.initialize();
        return provider;
    } catch {
        console.warn('TensorFlow unavailable, using simple hash embeddings');
        const provider = new SimpleEmbeddingProvider();
        await provider.initialize();
        return provider;
    }
}
