import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

export interface SummarizerSettings {
    provider: 'google' | 'openai' | 'anthropic' | 'mock';
    model: string;
    apiKey: string;
}

export interface Summarizer {
    summarize(code: string): Promise<string>;
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

        const { text } = await generateText({
            model: google(this.settings.model),
            prompt: `Summarize the following code symbol technically and concisely (1-3 sentences):

${code}`,
            headers: {
                'Authorization': `Bearer ${this.settings.apiKey}`
            }
        });

        return text.trim();
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
