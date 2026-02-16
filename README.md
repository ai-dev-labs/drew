# drew

**drew** is a Code-Graph & Specification Engine designed to bridge the gap between source code and natural language requirements. It extracts a high-fidelity graph of code symbols, generates technical summaries, and derives formal specifications, enabling both AI agents and humans to navigate codebases with precision.

## Architecture

The project follows a three-layered architectural mapping:

1.  **Intent**: The high-level purpose and user-facing goals of the system.
2.  **Specification**: Formal requirements and acceptance criteria in **EARS** (Easy Approach to Requirements Syntax) format, derived from the implementation.
3.  **Code-Graph**: A detailed map of code symbols (functions, classes, traits, etc.) extracted via Tree-sitter and enriched with AI-generated technical summaries.

## Core Features

-   **Multi-Language Extraction**: Built-in support for **Rust** and **TypeScript/TSX** using Tree-sitter.
-   **AI-Driven Summarization**: Automatically generates concise, technical summaries for every extracted symbol.
-   **Automated Specification Layer**: Transforms code summaries into formal requirements and acceptance criteria.
-   **Incremental Generation**: Uses checksum-based tracking to update only what has changed, minimizing LLM overhead.
-   **Traceability**: Maintains bi-directional links between high-level requirements and the underlying code nodes.

## System Specifications (EARS)

The following requirements are automatically extracted and maintained by the system:

### Data Model
-   **CodeGraphNode (REQ-CODEGRAPHNODE-1)**: The system SHALL represent code symbols with identifiable information, location details, and a content verification mechanism.
-   **Requirement (REQ-REQUIREMENT-1)**: The system SHALL provide a structured representation for software requirements, including a unique ID, description, acceptance criteria, associated node IDs, and a checksum.
-   **SpecMap (REQ-SPECMAP-1)**: The system SHALL maintain a comprehensive map of code analysis results, storing `CodeGraphNode` objects by their IDs and optionally `Requirement` objects.
-   **LanguageConfig (REQ-LANGCONFIG-1)**: The system SHALL support configurable language parsing with a parser, symbol extraction query, and file extensions.

### Core Engine
-   **Initialization (REQ-CONSTRUCTOR-1)**: The ExtractionEngine SHALL be initialized with configured language support for Rust and TypeScript, defining specific queries and file extensions for each.
-   **Config Lookup (REQ-GETCONFIGFORFILE-1)**: The system SHALL retrieve language configurations based on file extensions.
-   **Directory Traversal (REQ-WALK-1)**: The system SHALL recursively traverse directories to identify supported files, respecting ignore rules and skipping common directories like `node_modules`.
-   **Extraction (REQ-ENGINE-EXTRACT-001)**: The system SHALL extract code symbols from a given file based on its language configuration.
-   **Checksum (REQ-ENGINE-CHECKSUM-001)**: The system SHALL compute a SHA-256 checksum for an array of code symbol IDs and their corresponding node checksums to detect changes in specifications.
-   **Persistence (REQ-ENGINE-SAVEMAP-001)**: The system SHALL save the generated `SpecMap` to `.drew/spec-map.json` with pretty-printing, creating the `.drew` directory if needed.

### AI & Summarization
-   **Summarizer Interface (REQ-SUMMARIZER-INTERFACE-001)**: The system SHALL provide an interface for generating technical summaries from code snippets and producing structured specifications, with methods for single summarization, batch summarization, and specialization.
-   **Settings**: The `SummarizerSettings` SHALL define provider, model, and optional API keys or AWS credentials.
-   **Model Selection**: The `getModel()` helper SHALL return a language model based on the provider settings (Google or Bedrock).
-   **Batch Summarization**: The system SHALL summarize multiple code symbols in a batch using a language model.
-   **Specification Generation**: The system SHALL generate high-level requirements and acceptance criteria for code symbols using a language model.

## Getting Started

### Prerequisites
- Node.js
- An AI provider: Google Gemini API key **or** AWS Bedrock access

### Setup
1. Clone the repository.
2. Install dependencies: `npm install`
3. Configure your settings in `~/.drew/settings.json`:

   **Google provider:**
   ```json
   {
     "provider": "google",
     "model": "gemini-2.5-flash-lite",
     "apiKey": "YOUR_API_KEY"
   }
   ```

   **AWS Bedrock provider:**
   ```json
   {
     "provider": "bedrock",
     "aws_profile": "your-profile",
     "aws_region": "us-west-2"
   }
   ```
   The default model is `us.amazon.nova-lite-v1:0`. Override with a `"model"` field if needed. Requires a valid AWS profile with `bedrock:InvokeModel` permissions.

4. Build the project: `npm run build`

## Usage

To extract the code graph and specifications for a project:

```bash
drew extract <project-directory>
```

The results will be stored in `<project-directory>/.drew/spec-map.json`.
