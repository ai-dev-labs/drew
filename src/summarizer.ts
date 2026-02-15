import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';

export interface SummarizerSettings {
    provider: 'google' | 'openai' | 'anthropic' | 'mock';
    model: string;
    apiKey: string;
}

export interface Summarizer {
    summarize(code: string): Promise<string>;
    summarizeBatch(items: { id: string, code: string }[]): Promise<Record<string, string>>;
}

export class AISummarizer implements Summarizer {
    private settings: SummarizerSettings;

    constructor(settings: SummarizerSettings) {
        this.settings = settings;
    }

    async summarize(code: string): Promise<string> {
        if (this.settings.provider === 'mock') {
            return `Summary for: ${code.substring(0, 20)}...`;
        }

        if (this.settings.provider !== 'google') {
            throw new Error(`Provider ${this.settings.provider} not implemented yet.`);
        }

        const google = createGoogleGenerativeAI({
            apiKey: this.settings.apiKey
        });

        const { text } = await generateText({
            model: google(this.settings.model),
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

        if (this.settings.provider !== 'google') {
            throw new Error(`Provider ${this.settings.provider} not implemented yet.`);
        }

        const google = createGoogleGenerativeAI({
            apiKey: this.settings.apiKey
        });

        const { object } = await generateObject({
            model: google(this.settings.model),
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
}

export async function loadSettings(): Promise<SummarizerSettings> {
    const settingsPath = path.join(os.homedir(), '.drew', 'settings.json');
    if (!await fs.pathExists(settingsPath)) {
        throw new Error(`Settings file not found at ${settingsPath}`);
    }

    try {
        const settings = await fs.readJson(settingsPath);
        if (!settings.provider || !settings.apiKey) {
            throw new Error('Invalid settings: provider and apiKey are required.');
        }
        return {
            provider: settings.provider,
            model: settings.model || 'gemini-2.5-flash-lite',
            apiKey: settings.apiKey
        };
    } catch (err: any) {
        throw new Error(`Failed to load settings: ${err.message}`);
    }
}
