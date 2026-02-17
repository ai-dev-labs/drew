# drew

**drew** is a Code-Graph & Specification Engine that extracts code symbols, generates AI-powered summaries, and derives formal EARS specifications — with built-in semantic vector search for AI agent code exploration.

## Architecture

Three-layered mapping:

1. **Intent** — High-level purpose and user-facing goals.
2. **Specification** — Formal EARS requirements and acceptance criteria derived from code.
3. **Code-Graph** — Extracted symbols (functions, classes, traits, etc.) enriched with AI summaries.

## Features

- **Multi-Language Extraction** — Rust and TypeScript/TSX via Tree-sitter.
- **AI Summarization** — Technical summaries for every symbol via Google Gemini or AWS Bedrock.
- **Specification Generation** — EARS requirements with acceptance criteria, linked to code nodes.
- **Incremental Processing** — Checksum-based change detection; only re-processes what changed.
- **Semantic Vector Search** — Natural language search over code and specs using [zvec](https://github.com/alibaba/zvec) + TensorFlow.js Universal Sentence Encoder.
- **Agent Instructions** — Built-in `drew instructions` command outputs a guide for AI agents.

## Getting Started

### Prerequisites

- Node.js
- An AI provider: Google Gemini API key **or** AWS Bedrock access

### Setup

1. Clone the repository.
2. Install dependencies: `npm install --legacy-peer-deps`
3. Configure `~/.drew/settings.json`:

   **AWS Bedrock:**
   ```json
   {
     "provider": "bedrock",
     "model": "us.amazon.nova-lite-v1:0",
     "aws_profile": "your-profile",
     "aws_region": "us-west-2"
   }
   ```
   Requires a valid AWS profile with `bedrock:InvokeModel` permissions. The default model is `us.amazon.nova-lite-v1:0`.

   **Optional settings:**

   | Key | Type | Default | Description |
   |-----|------|---------|-------------|
   | `indexing_concurrency` | `number` | `20` | Number of parallel workers used during `drew index`. Increase on machines with more resources. |

   Example with concurrency tuning:
   ```json
   {
     "provider": "bedrock",
     "aws_profile": "your-profile",
     "aws_region": "us-west-2",
     "indexing_concurrency": 50
   }
   ```

   **Google Gemini:**
   ```json
   {
     "provider": "google",
     "model": "gemini-2.5-flash-lite",
     "apiKey": "YOUR_API_KEY"
   }
   ```

4. Build: `npm run build`

## Usage

### Extract

```bash
drew extract <project-directory>
```

Extracts code symbols, generates summaries, and derives EARS specifications. Results are stored in `<project-directory>/.drew/spec-map.json`.

### Index

Build the vector search index from the extracted spec-map:

```bash
drew index [path]           # Index (or update) the vector store
drew index --reindex        # Destroy and fully rebuild the index
```

The index is stored at `.drew/.data/` and is rebuildable at any time.

### Search

Semantic search over code nodes and specifications:

```bash
drew search "error handling"              # Default limit of 10
drew search "authentication" --limit 5    # Limit results
drew search "parsing" --type spec         # Only specifications
drew search "tree-sitter" --type node     # Only code symbols
drew search "extract" --json              # Machine-readable JSON output
```

Results are ranked by relevance (highest score first). Specification results include their linked code nodes.

### Get

Retrieve a document by its exact ID:

```bash
drew get "src/engine.ts:extractAll"       # Get a code node
drew get "REQ-EXTRACTALL-1"              # Get a spec + linked code nodes
drew get "REQ-EXTRACTALL-1" --json       # JSON output
```

### Delete

Remove a document from the index:

```bash
drew delete "src/engine.ts:extractAll"
```

### Instructions

Output AI agent instructions for using drew to explore code:

```bash
drew instructions
```

This prints a structured guide that teaches an AI agent how to use drew's search and retrieval commands before writing or modifying code.

## Example: End-to-End with Bedrock

```bash
# 1. Configure Bedrock
cat > ~/.drew/settings.json << 'EOF'
{
  "provider": "bedrock",
  "aws_profile": "herdapp",
  "aws_region": "us-west-2"
}
EOF

# 2. Extract symbols and generate specs
drew extract ./my-project

# 3. Build the vector index
drew index ./my-project

# 4. Search for relevant code
drew search "user authentication"

# 5. Get full details on a result
drew get "src/auth.ts:validateToken"

# 6. Search for related specs
drew search "authentication" --type spec
```

## Integrating with Kiro AgentSpawn Hooks

Use `drew instructions` to inject code exploration context into AI agent sessions via Kiro's AgentSpawn hooks. This ensures agents always explore the codebase with drew before writing code.

### Setup

Add a hook to your `.kiro/hooks/agent_spawn.md` (or the appropriate hook configuration file):

```markdown
# Agent Spawn Hook

## Code Exploration with Drew

Before starting any coding task, the agent must understand the codebase using drew.

### Instructions

Run the following command and follow the instructions it outputs:

\`\`\`bash
drew instructions
\`\`\`

### Required Workflow

1. Run `drew instructions` and read the output.
2. Use `drew search` to find code and specs relevant to the task.
3. Use `drew get` to retrieve full details on relevant results.
4. Only after exploration, proceed with implementation.

### Pre-conditions

- The project must have been extracted: `drew extract .`
- The vector index must exist: `drew index`

If either is missing, run those commands first.
```

This hook fires whenever a new agent session starts, ensuring every agent begins by exploring relevant code through drew's semantic search rather than guessing at file locations or function signatures.

## Data Storage

```
.drew/
├── spec-map.json        # Extracted nodes + specifications (source of truth)
├── .data/               # zvec vector index (derived, rebuildable)
└── specs/               # RFC/spec markdown files
```

- `spec-map.json` is the primary artifact and should be committed to source control.
- `.drew/.data/` is a derived index — rebuildable via `drew index --reindex`.
- The `models/` directory contains the TensorFlow.js Universal Sentence Encoder model files (~27MB) used for local embeddings.
