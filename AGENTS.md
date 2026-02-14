# Project Preferences: drew

## Architecture
- **Layered Mapping**: Use a three-layered structure: **Intent**, **Specification**, and **Code-Graph**.
- **Persistence**: Centralized mapping stored in `.drew/spec-map.json`.
- **Updates**: The mapping file shall be updated in-place during incremental generation and kept under source control.

## Implementation
- **Language**: Implemented in **TypeScript** (Node.js).
- **Parsing**: Multi-language support (Rust, TypeScript, TSX) via Tree-sitter.
- **Natural Language**: Use **lightweight LLMs** to generate descriptions for the Intent and Specification layers, and technical summaries for the Code-Graph.

## Workflows
- **PR Management**: All changes must be submitted via the `review` skill to ensure proper rebasing, issue linking, and squash-merge compliance.
- **Testing**: Use `mocha` for unit tests and shell scripts for functional verification.
- **Artifacts**: Store all specifications in `docs/specs/` and maintain them under version control.
- **Issue Linking**: Specifications must be linked to a GitHub issue upon creation.
- **Incremental Generation**: Use `git diff` to identify modified code blocks and re-parse only affected areas.
- **Documentation Adapters**: Enable plugins to generate external docs (READMEs, API guides) from the top two layers.
