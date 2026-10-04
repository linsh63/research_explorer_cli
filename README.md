# Research Explorer CLI

Research Explorer is the official Pi-based command-line client for the Auto Research Agent core. Its executable is:

```bash
rexplore
```

The product reuses Pi's TUI, model authentication, sessions, streaming, tools, skills, compaction, themes, and RPC mode. Research state and gates remain in the separately deployed Core Service.

## Current status

C0 and C1 are complete. Research Explorer can discover or start Core, create/open a Project, show status and restore the binding after CLI and Core restarts. Research action workflows begin in C2.

```bash
npm ci
npm test
npm run validate:c0
npm run validate:c1
node dist/launcher.js --version
```

No model authentication or model call is required for C0/C1 validation.

## Try C1 from the two development checkouts

```bash
cd /data0/linsihan/auto-research-agent
npm run build

cd /data0/linsihan/research-explorer-cli
npm ci
npm run build
node dist/launcher.js --offline \
  --research-core-entry /data0/linsihan/auto-research-agent/dist/service/cli.js
```

Inside Research Explorer:

```text
/research-doctor
/research-new My first research project
/research-status
```

Later runs use the saved Core discovery and recent Project automatically. Use `/research-open <project-id>` to switch Projects.

## Architecture boundary

```text
rexplore launcher -> Pi CLI + Research Explorer extension -> public Core SDK/API
```

The CLI does not import Core internals or access its database. See the [Pi decision](docs/architecture/decisions/001-pi-extension-shell.md), [Core boundary decision](docs/architecture/decisions/002-core-service-boundary.md), [C1 report](docs/reports/stages/c1-progress.md) and [Core API gap register](docs/core-api-gaps.md).

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
