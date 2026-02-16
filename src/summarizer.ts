import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromIni } from '@aws-sdk/credential-providers';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';

export interface SummarizerSettings {
    provider: 'google' | 'bedrock' | 'openai' | 'anthropic' | 'mock';
    model: string;
    apiKey?: string;
    aws_profile?: string;
    aws_region?: string;
}

export interface Summarizer {
    summarize(code: string): Promise<string>;
    summarizeBatch(items: { id: string, code: string }[]): Promise<Record<string, string>>;
    specialize(items: { id: string, summary: string }[]): Promise<{ id: string, description: string, acceptance_criteria: string[], node_ids: string[] }[]>;
}

export class AISummarizer implements Summarizer {
    private settings: SummarizerSettings;

    constructor(settings: SummarizerSettings) {
        this.settings = settings;
    }

    private getModel() {
        if (this.settings.provider === 'google') {
            const google = createGoogleGenerativeAI({ apiKey: this.settings.apiKey! });
            return google(this.settings.model);
        }
        if (this.settings.provider === 'bedrock') {
            const bedrock = createAmazonBedrock({
                region: this.settings.aws_region!,
                credentialProvider: fromIni({ profile: this.settings.aws_profile! }),
            });
            return bedrock(this.settings.model);
        }
        throw new Error(`Provider ${this.settings.provider} is not yet implemented.`);
    }

    async summarize(code: string): Promise<string> {
        if (this.settings.provider === 'mock') {
            return `Summary for: ${code.substring(0, 20)}...`;
        }

        const model = this.getModel();
        const { text } = await generateText({
            model,
            maxRetries: 5,
            prompt: `Summarize the following code symbol technically and concisely (1-3 sentences):\n\n${code}`
        });

        return text.trim();
    }

    async summarizeBatch(items: { id: string, code: string }[]): Promise<Record<string, string>> {
        if (items.length === 0) return {};

        if (this.settings.provider === 'mock') {
            const results: Record<string, string> = {};
            for (const item of items) {
                results[item.id] = `Summary for: ${item.code.substring(0, 20)}...`;
            }
            return results;
        }

        const model = this.getModel();
        const { object } = await generateObject({
            model,
            schema: z.object({
                summaries: z.array(z.object({
                    id: z.string(),
                    summary: z.string()
                }))
            }),
            maxRetries: 5,
            prompt: `Summarize each of the following code symbols technically and concisely (1-3 sentences).
Return a JSON object with a 'summaries' array containing 'id' and 'summary' for each item.

${items.map(item => `ID: ${item.id}\nCODE:\n${item.code}\n---`).join('\n')}`
        });

        const results: Record<string, string> = {};
        for (const item of object.summaries) {
            results[item.id] = item.summary;
        }
        return results;
    }

    async specialize(items: { id: string, summary: string }[]): Promise<{ id: string, description: string, acceptance_criteria: string[], node_ids: string[] }[] > {
        if (items.length === 0) return [];

        if (this.settings.provider === 'mock') {
            return items.map(item => ({
                id: `req-${item.id}`,
                description: `EARS Requirement for ${item.id}: The system shall process ${item.id} correctly.`,
                acceptance_criteria: [`${item.id} is processed.`],
                node_ids: [item.id]
            }));
        }

        const model = this.getModel();
        const { object } = await generateObject({
            model,
            schema: z.object({
                specifications: z.array(z.object({
                    id: z.string(),
                    description: z.string(),
                    acceptance_criteria: z.array(z.string()),
                    node_ids: z.array(z.string())
                }))
            }),
            maxRetries: 5,
            prompt: `Based on the following code symbol summaries, generate high-level requirements and acceptance criteria in EARS format.
Link each requirement to the corresponding symbol IDs.
Return a JSON object with a 'specifications' array.

${items.map(item => `ID: ${item.id}\nSUMMARY: ${item.summary}\n---`).join('\n')}`
        });

        return object.specifications;
    }
}

export async function loadSettings(): Promise<SummarizerSettings> {
    const settingsPath = path.join(os.homedir(), '.drew', 'settings.json');
    if (!await fs.pathExists(settingsPath)) {
        throw new Error(`Settings file not found at ${settingsPath}`);
    }

    try {
        const settings = await fs.readJson(settingsPath);
        if (!settings.provider) {
            throw new Error('Invalid settings: provider is required.');
        }

        if (settings.provider === 'bedrock') {
            if (!settings.aws_profile || !settings.aws_region) {
                throw new Error('Invalid settings: aws_profile and aws_region are required for bedrock provider.');
            }
            return {
                provider: settings.provider,
                model: settings.model || 'us.amazon.nova-lite-v1:0',
                aws_profile: settings.aws_profile,
                aws_region: settings.aws_region
            };
        }

        if (settings.provider === 'google') {
            if (!settings.apiKey) {
                throw new Error('Invalid settings: apiKey is required for google provider.');
            }
            return {
                provider: settings.provider,
                model: settings.model || 'gemini-2.5-flash-lite',
                apiKey: settings.apiKey
            };
        }

        // mock and other providers
        return {
            provider: settings.provider,
            model: settings.model || 'gemini-2.5-flash-lite',
            apiKey: settings.apiKey
        };
    } catch (err: any) {
        throw new Error(`Failed to load settings: ${err.message}`);
    }
}
