# Research Explorer CLI

Research Explorer is the official Pi-based command-line client for the Auto Research Agent core. Its executable is:

```bash
rexplore
```

The product reuses Pi's TUI, model authentication, sessions, streaming, tools, skills, compaction, themes, and RPC mode. Research state and gates remain in the separately deployed Core Service.

## Current status

C0 is complete. It validates the Pi extension and thin-launcher architecture, durable session entries, cancellation and installation from the packed npm artifact. It does not yet connect to Core or implement end-user research workflows.

```bash
npm ci
npm test
npm run validate:c0
node dist/launcher.js --version
```

No model authentication or model call is required for C0 validation.

## Architecture boundary

```text
rexplore launcher -> Pi CLI + Research Explorer extension -> public Core SDK/API
```

The C0 package implements the first two parts. It does not import Core internals or access its database. See the [architecture decision](docs/architecture/decisions/001-pi-extension-shell.md), [C0 report](docs/reports/stages/c0-progress.md) and [Core API gap register](docs/core-api-gaps.md).

## Requirements

- Node.js 22.19 or newer
- Linux or macOS for the planned v0.1 support matrix

## Development

```bash
npm ci
npm run check
npm run check:boundaries
npm test
npm run validate:c0
npm audit --audit-level=high
```
