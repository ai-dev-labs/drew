import { expect } from 'chai';
import { AISummarizer, loadSettings } from '../src/summarizer';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

describe('Bedrock Provider', () => {
    let homeDir: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drew-test-home-'));
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;
        await fs.ensureDir(path.join(homeDir, '.drew'));
    });

    afterEach(async () => {
        await fs.remove(homeDir);
        process.env.HOME = originalHome;
    });

    describe('loadSettings()', () => {
        it('should load valid bedrock config with default model', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'bedrock',
                aws_profile: 'herdapp',
                aws_region: 'us-west-2'
            });

            const settings = await loadSettings();
            expect(settings.provider).to.equal('bedrock');
            expect(settings.aws_profile).to.equal('herdapp');
            expect(settings.aws_region).to.equal('us-west-2');
            expect(settings.model).to.equal('us.amazon.nova-lite-v1:0');
        });

        it('should load bedrock config with custom model', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'bedrock',
                aws_profile: 'herdapp',
                aws_region: 'us-west-2',
                model: 'anthropic.claude-3-haiku-20240307-v1:0'
            });

            const settings = await loadSettings();
            expect(settings.provider).to.equal('bedrock');
            expect(settings.model).to.equal('anthropic.claude-3-haiku-20240307-v1:0');
        });

        it('should throw when aws_profile is missing for bedrock provider', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'bedrock',
                aws_region: 'us-west-2'
            });

            try {
                await loadSettings();
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.contain('aws_profile');
                expect(err.message).to.contain('aws_region');
            }
        });

        it('should throw when aws_region is missing for bedrock provider', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'bedrock',
                aws_profile: 'herdapp'
            });

            try {
                await loadSettings();
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.contain('aws_profile');
                expect(err.message).to.contain('aws_region');
            }
        });

        it('should not require apiKey for bedrock provider', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'bedrock',
                aws_profile: 'herdapp',
                aws_region: 'us-west-2'
            });

            const settings = await loadSettings();
            expect(settings.provider).to.equal('bedrock');
            // apiKey should be undefined — not required for bedrock
            expect(settings.apiKey).to.be.undefined;
        });

        it('should still require apiKey for google provider', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'google',
                model: 'gemini-2.5-flash-lite',
                apiKey: 'AIza-test-key'
            });

            const settings = await loadSettings();
            expect(settings.provider).to.equal('google');
            expect(settings.apiKey).to.equal('AIza-test-key');
            expect(settings.model).to.equal('gemini-2.5-flash-lite');
        });

        it('should throw when apiKey is missing for google provider', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'google',
                model: 'gemini-2.5-flash-lite'
            });

            try {
                await loadSettings();
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.contain('apiKey');
            }
        });

        it('should load mock provider without apiKey', async () => {
            await fs.writeJson(path.join(homeDir, '.drew', 'settings.json'), {
                provider: 'mock',
                model: 'test-model',
                apiKey: 'test-key'
            });

            const settings = await loadSettings();
            expect(settings.provider).to.equal('mock');
        });
    });

    describe('AISummarizer with mock provider', () => {
        it('should still work for summarize()', async () => {
            const summarizer = new AISummarizer({
                provider: 'mock',
                model: 'test-model',
                apiKey: 'test-key'
            });

            const result = await summarizer.summarize('function hello() {}');
            expect(result).to.contain('Summary for:');
        });

        it('should still work for summarizeBatch()', async () => {
            const summarizer = new AISummarizer({
                provider: 'mock',
                model: 'test-model',
                apiKey: 'test-key'
            });

            const result = await summarizer.summarizeBatch([
                { id: 'fn1', code: 'function hello() {}' }
            ]);
            expect(result['fn1']).to.contain('Summary for:');
        });

        it('should still work for specialize()', async () => {
            const summarizer = new AISummarizer({
                provider: 'mock',
                model: 'test-model',
                apiKey: 'test-key'
            });

            const result = await summarizer.specialize([
                { id: 'fn1', summary: 'A function that says hello' }
            ]);
            expect(result).to.have.length(1);
            expect(result[0].id).to.equal('req-fn1');
            expect(result[0].description).to.contain('EARS Requirement');
        });
    });
});
