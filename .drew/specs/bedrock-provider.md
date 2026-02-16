# RFC: AWS Bedrock Provider Support

**Type**: New Feature
**Priority**: P1-High
**Status**: Draft

## Abstract

Add AWS Bedrock as a new AI provider for drew's summarization and specification generation pipeline. This enables users who operate within AWS environments to use Bedrock-hosted models (e.g., Amazon Nova, Claude) for code symbol summarization and EARS specification generation, authenticating via AWS profile-based credentials rather than API keys.

## Problem Statement

**Current state**: The `AISummarizer` class in `src/summarizer.ts` only supports `google` and `mock` providers. The `openai` and `anthropic` provider values exist in the type union but throw "not yet implemented" errors. All non-mock providers require an `apiKey` in `~/.drew/settings.json`.

**Pain points**:
- Users in AWS-centric environments cannot use their existing AWS credentials and Bedrock access.
- There is no way to use AWS-hosted models for summarization.
- The `apiKey` field is required for all providers, which is unnecessary for credential-chain-based services like Bedrock.

**Impact of not solving**: Users must obtain and manage separate Google API keys even when they already have AWS Bedrock access configured.

## Hypothesis

We believe that adding an AWS Bedrock provider to the summarizer
for users operating in AWS environments
will result in seamless adoption of drew without requiring external API key management.
We will know this is true when the `drew extract` command successfully generates summaries and specifications using a Bedrock model authenticated via AWS profile.

## Goals

1. **Must**: Implement a working `bedrock` provider that performs `summarize`, `summarizeBatch`, and `specialize` operations via AWS Bedrock.
2. **Must**: Support AWS profile-based authentication (SDK credential provider chain).
3. **Must**: Add `aws_profile`, `aws_region`, and `bedrock_model` configuration fields to settings.
4. **Non-goal**: Supporting explicit AWS access key/secret key in settings.
5. **Non-goal**: Adding OpenAI or Anthropic (direct API) providers in this change.

## Solution Design

### Approach

Use the `@ai-sdk/amazon-bedrock` package from the Vercel AI SDK. This integrates with the existing `ai` package (`generateText`, `generateObject`) already used by the Google provider, minimizing code changes.

### Configuration Changes

#### `SummarizerSettings` interface (`src/summarizer.ts`)

```typescript
export interface SummarizerSettings {
    provider: 'google' | 'bedrock' | 'openai' | 'anthropic' | 'mock';
    model?: string;        // Required for google, optional for bedrock (has default)
    apiKey?: string;       // Required for google, not used for bedrock
    aws_profile?: string;  // Bedrock only: AWS profile name
    aws_region?: string;   // Bedrock only: AWS region (e.g., 'us-west-2')
}
```

#### Settings file (`~/.drew/settings.json`)

**Google provider example** (existing, unchanged):
```json
{
    "provider": "google",
    "model": "gemini-2.5-flash-lite",
    "apiKey": "AIza..."
}
```

**Bedrock provider example** (new):
```json
{
    "provider": "bedrock",
    "aws_profile": "herdapp",
    "aws_region": "us-west-2",
    "bedrock_model": "us.amazon.nova-lite-v1:0"
}
```

#### `loadSettings()` changes

- When `provider` is `google`: require `apiKey`, default model to `gemini-2.5-flash-lite`.
- When `provider` is `bedrock`: require `aws_profile` and `aws_region`, default model to `us.amazon.nova-lite-v1:0`. `apiKey` is not required.
- When `provider` is `mock`: no additional fields required.

### Provider Implementation

#### Bedrock provider creation in `AISummarizer`

```typescript
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromIni } from '@aws-sdk/credential-providers';

// Inside AISummarizer methods, when provider === 'bedrock':
const bedrock = createAmazonBedrock({
    region: this.settings.aws_region,
    credentialProvider: fromIni({ profile: this.settings.aws_profile }),
});

const { text } = await generateText({
    model: bedrock(this.settings.model || 'us.amazon.nova-lite-v1:0'),
    maxRetries: 5,
    prompt: '...'
});
```

#### Methods to modify

All three methods in `AISummarizer` follow the same pattern. Each currently has:
1. A `mock` check (keep as-is)
2. A `google`-only gate that throws for other providers (replace with provider switch)

**`summarize()`** (`src/summarizer.ts:27-47`):
- Add bedrock branch that creates a Bedrock provider and calls `generateText`.

**`summarizeBatch()`** (`src/summarizer.ts:49-88`):
- Add bedrock branch that creates a Bedrock provider and calls `generateObject`.

**`specialize()`** (`src/summarizer.ts:90-129`):
- Add bedrock branch that creates a Bedrock provider and calls `generateObject`.

### Refactoring Opportunity

To avoid duplicating provider creation logic across three methods, extract a private helper:

```typescript
private getModel() {
    if (this.settings.provider === 'google') {
        const google = createGoogleGenerativeAI({ apiKey: this.settings.apiKey! });
        return google(this.settings.model || 'gemini-2.5-flash-lite');
    }
    if (this.settings.provider === 'bedrock') {
        const bedrock = createAmazonBedrock({
            region: this.settings.aws_region!,
            credentialProvider: fromIni({ profile: this.settings.aws_profile! }),
        });
        return bedrock(this.settings.model || 'us.amazon.nova-lite-v1:0');
    }
    throw new Error(`Provider ${this.settings.provider} is not yet implemented.`);
}
```

This reduces each method to:
```typescript
const model = this.getModel();
const { text } = await generateText({ model, maxRetries: 5, prompt: '...' });
```

## Dependencies

### New npm packages

| Package | Purpose |
|---------|---------|
| `@ai-sdk/amazon-bedrock` | Vercel AI SDK provider for AWS Bedrock |
| `@aws-sdk/credential-providers` | Provides `fromIni()` for profile-based AWS credential resolution |

### Existing packages (unchanged)

- `ai` (Vercel AI SDK core) - already used
- `@ai-sdk/google` - already used, unchanged
- `zod` - already used for schema validation

### AWS prerequisites

- User must have a valid AWS profile configured in `~/.aws/credentials` or `~/.aws/config`.
- The profile must have `bedrock:InvokeModel` permissions for the chosen model.
- The chosen Bedrock model must be enabled in the target AWS region.

## Data Model Changes

### `SummarizerSettings` interface

| Field | Type | Required | Provider | Description |
|-------|------|----------|----------|-------------|
| `provider` | `'google' \| 'bedrock' \| 'mock'` | Yes | All | AI provider selection |
| `model` | `string` | Google: yes, Bedrock: no | google, bedrock | Model identifier. Defaults: google=`gemini-2.5-flash-lite`, bedrock=`us.amazon.nova-lite-v1:0` |
| `apiKey` | `string` | Google: yes | google | API key for authentication |
| `aws_profile` | `string` | Bedrock: yes | bedrock | AWS CLI profile name |
| `aws_region` | `string` | Bedrock: yes | bedrock | AWS region for Bedrock endpoint |

## Error Handling

| Scenario | Error Message | System Action |
|----------|---------------|---------------|
| Missing `aws_profile` when provider=bedrock | `Invalid settings: aws_profile and aws_region are required for bedrock provider.` | Throw, abort extraction |
| Missing `aws_region` when provider=bedrock | Same as above | Throw, abort extraction |
| AWS profile not found | SDK-level error: credential resolution fails | Throw, surface SDK error message |
| Bedrock model not enabled in region | SDK-level 4xx error | Throw, surface error with hint to check model access |
| Bedrock throttling (429) | Existing retry logic via `maxRetries: 5` | Retry up to 5 times (Vercel AI SDK handles this) |
| Invalid AWS credentials (expired SSO) | SDK-level auth error | Throw, surface error suggesting `aws sso login --profile <profile>` |

## Testing Strategy

### Unit tests

| Test ID | Scenario | Expected |
|---------|----------|----------|
| T1 | `loadSettings()` with valid bedrock config (aws_profile, aws_region) | Returns settings with provider=bedrock, default model |
| T2 | `loadSettings()` with bedrock config missing aws_profile | Throws validation error |
| T3 | `loadSettings()` with bedrock config missing aws_region | Throws validation error |
| T4 | `loadSettings()` with bedrock config + custom model | Returns settings with specified model |
| T5 | `loadSettings()` with google config (existing behavior) | Unchanged behavior, requires apiKey |
| T6 | `AISummarizer.getModel()` with bedrock provider | Returns a Bedrock model instance |
| T7 | `AISummarizer.getModel()` with google provider | Returns a Google model instance |
| T8 | Mock provider still works for summarize/summarizeBatch/specialize | Unchanged behavior |

### Integration tests (manual)

| Test | Steps | Expected |
|------|-------|----------|
| I1 | Configure bedrock in settings, run `drew extract .` | Full extraction with Bedrock-generated summaries |
| I2 | Configure bedrock with wrong profile | Clear error about credential resolution |
| I3 | Configure bedrock with model not enabled in region | Clear error about model access |

## Implementation Plan

### Phase 1: Settings & Validation

**Files**: `src/summarizer.ts`

1. Update `SummarizerSettings` interface to add `aws_profile`, `aws_region` fields and make `apiKey` optional.
2. Update `loadSettings()` to validate provider-specific required fields.
3. Add/update tests for settings validation.

### Phase 2: Bedrock Provider

**Files**: `src/summarizer.ts`, `package.json`

1. Install `@ai-sdk/amazon-bedrock` and `@aws-sdk/credential-providers`.
2. Add `import` statements for Bedrock SDK.
3. Extract `getModel()` private helper method.
4. Refactor `summarize()`, `summarizeBatch()`, and `specialize()` to use `getModel()`.
5. Add bedrock branch in `getModel()`.

### Phase 3: Tests

**Files**: `tests/` directory

1. Add settings validation tests for bedrock configuration.
2. Verify mock provider is unaffected.
3. Verify google provider is unaffected.

## Files Changed

| File | Change |
|------|--------|
| `src/summarizer.ts` | Update interface, add Bedrock imports, extract `getModel()`, update `loadSettings()` |
| `package.json` | Add `@ai-sdk/amazon-bedrock`, `@aws-sdk/credential-providers` |
| `tests/` (new or existing) | Settings validation tests for bedrock |

## Alternatives Considered

| Alternative | Pros | Cons | Why Not |
|-------------|------|------|---------|
| Use AWS SDK directly (no Vercel AI SDK provider) | No new dependency on `@ai-sdk/amazon-bedrock` | Breaks the `generateText`/`generateObject` pattern; requires manual Bedrock API calls, response parsing | Inconsistent with existing architecture |
| Support env vars for AWS config | Flexible for CI/CD | Adds complexity; settings file is the established pattern | User preference for settings file only |
| Require explicit AWS keys in settings | Simpler auth code | Bad security practice; doesn't support SSO/assumed roles | User preference for profile-based auth |

## Acceptance Criteria

- [ ] `drew extract .` works with `provider: "bedrock"` in settings
- [ ] AWS profile-based authentication works (no API key needed for bedrock)
- [ ] Default model is `us.amazon.nova-lite-v1:0` when `bedrock_model` not specified
- [ ] Clear error when `aws_profile` or `aws_region` missing for bedrock provider
- [ ] Google provider continues working unchanged
- [ ] Mock provider continues working unchanged
- [ ] Settings validation tests pass for all provider configurations
