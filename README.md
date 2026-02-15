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

### Core Engine
-   **ExtractionEngine (REQ-EE-001)**: The system SHALL be responsible for parsing source code, extracting symbols, AI summarization, and formal specification generation.
-   **Multi-Language Support (REQ-EE-CON-001)**: When instantiated, the engine SHALL configure initial support for Rust and TypeScript.
-   **Directory Traversal (REQ-EE-WALK-001)**: The system SHALL recursively traverse directories while respecting `.drewignore` and skipping common directories like `node_modules`.
-   **File Extraction (S001_CODE_EXTRACTION)**: When a file is processed, the system SHALL extract symbols based on its language-specific configuration.

### AI & Summarization
-   **AI Summarization (S005_AI_SUMMARIZATION_REQUIREMENTS)**: The system SHALL implement AI-driven generation of code summaries and formal EARS requirements.
-   **Batch Processing (REQ-EE-PB-001)**: The system SHALL asynchronously handle batches of code symbols to optimize AI interactions.
-   **Contextual Linking**: Each generated requirement SHALL be linked to its corresponding original code symbol IDs for traceability.

### Data & Persistence
-   **SpecMap (REQ-SM-001)**: The system SHALL maintain a `SpecMap` to store `CodeGraphNode` objects and linked `Requirement` objects.
-   **Persistence (S002_SPECMAP_PERSISTENCE)**: The system SHALL save the generated mapping to `.drew/spec-map.json` with pretty-printing.

## Getting Started

### Prerequisites
- Node.js
- An AI Provider API Key (Google Gemini recommended)

### Setup
1. Clone the repository.
2. Install dependencies: `npm install`
3. Configure your settings in `~/.drew/settings.json`:
   ```json
   {
     "provider": "google",
     "model": "gemini-2.5-flash-lite",
     "apiKey": "YOUR_API_KEY"
   }
   ```
4. Build the project: `npm run build`

## Usage

To extract the code graph and specifications for a project:

```bash
drew extract <project-directory>
```

The results will be stored in `<project-directory>/.drew/spec-map.json`.
