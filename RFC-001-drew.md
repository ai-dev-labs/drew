# 001: drew - Layered Specification Extraction CLI

## Status
Proposed

## Summary
**drew** is a command-line interface tool designed to extract software specifications from existing code or repository commits. The tool organizes extracted information into inter-mapped layers, enabling agents to trace requirements back to their source locations. It supports incremental generation based on commit diffs for performance and scalability.

## Motivation
To enable AI agents to better understand and implement features in large codebases by providing a clear, machine-readable mapping from high-level intent down to specific source code locations. Existing tools often lack the layered context and incremental update capabilities required for efficient agentic workflows.

## Requirements (EARS Format)

### Ubiquitous
- **drew** shall support extracting specifications from a local git repository.
- **drew** shall store extracted specifications in a four-layered structure: **Intent**, **Specification**, **Logic**, and **Source**.
- **drew** shall map elements in the **Intent** layer down to the **Source** layer.
- **drew** shall provide an adapter interface for generating external documentation (e.g., READMEs, API guides) from the **Intent** and **Specification** layers.

### Event-driven
- When a commit hash is provided, **drew** shall extract specifications based on the changes in that commit.
- When a directory path is provided, **drew** shall scan the code within that directory for specification extraction.
- When the `generate` command is called with a specific adapter, **drew** shall produce the requested documentation.

### Unwanted Behavior
- If the provided directory is not a git repository, then **drew** shall display an error message and exit.
- If a commit hash is invalid or not found, then **drew** shall report an error.
- If the **Source** layer checksum for a file does not match its current physical state, then **drew** shall mark the associated **Logic** layer entries as stale and initiate a re-parse.

### State-driven
- While performing incremental generation, **drew** shall only process files changed in the specified commit diff.

### Optional Features
- Where a remote GitHub URL is provided, **drew** shall attempt to clone and extract specifications from the remote repository.
- **drew** shall initially support extraction from **Rust** source code.

## Detailed Design
- **Layering Strategy**:
    - **Intent**: High-level purpose and user-facing features.
    - **Specification**: EARS-formatted requirements and business rules.
        - *Fields*: `id`, `pattern` (EARS), `statement`, `logic_refs` (implementation links), `intent_id`.
    - **Logic**: Technical implementations, function signatures, and logic blocks.
        - *Fields*: `id`, `kind` (e.g., function, struct), `name`, `namespace`, `references` (dependencies), `source_id`.
    - **Source**: File paths, line ranges, and commit SHAs.
        - *Fields*: `id`, `path`, `commit_sha`, `start_byte`, `end_byte`, `start_line`, `end_line`, `checksum`.
    - **Intent**: High-level purpose and user-facing features.
        - *Fields*: `id`, `summary`, `description`, `tags`, `spec_ids`.
- **Technology Stack**:
    - **Tree-sitter**: Used to parse source code and build relationship graphs between Logic and Source layers.
    - **Lightweight LLMs**: Utilized to generate natural language descriptions for the Intent and Specification layers.
- **Persistence**: A centralized JSON file (e.g., `.gemini/spec-map.json`) stored under source control.
- **Incremental Generation**: Utilizes `git diff` to identify modified blocks and re-parses only affected areas.

## Drawbacks
- Complexity of maintaining a centralized JSON mapping file in large teams (potential for merge conflicts).
- Dependency on external LLMs for natural language generation.

## Alternatives
- Sidecar files (one JSON per source file) were considered but rejected in favor of a centralized graph for easier global lookup.

## Unresolved Questions
- Specific schema for the `.gemini/spec-map.json` file.
- Selection of the "lightweight LLM" to be used for local generation.
