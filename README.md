# Research Explorer CLI

Research Explorer is the official Pi-based command-line client for the Auto Research Agent core. Its executable is:

```bash
rexplore
```

The product reuses Pi's TUI, model authentication, sessions, streaming, tools, skills, compaction, themes, and RPC mode. Research state and gates remain in the separately deployed Core Service.

## Install and run

```bash
npm install -g --prefix "$HOME/.local" \
  research-explorer-core research-explorer-cli
export PATH="$HOME/.local/bin:$PATH"
rexplore
```

The installer places independently updatable `research-explorer-core` and `rexplore` commands in the same user prefix. After installation, `rexplore` works from any directory and starts Core automatically.

## Current status

C0 through C5 are complete. Stable `0.1.1` uses the unified `research-explorer-core` package name and supports Project context, research interaction modes, scientific capabilities and reports, persistent Jobs, Artifacts, SSH setup, Core research plugins, forks and Bundle v2 migration.

```bash
npm ci
npm test
npm run validate:c0
npm run validate:c1
npm run validate:c2
npm run validate:c3
npm run validate:c4
npm run validate:c5
node dist/launcher.js --version
```

No model authentication or model call is required for C0/C1 validation.

## Run from development checkouts

```bash
cd /path/to/research_explorer_core
npm run build

cd /data0/linsihan/research-explorer-cli
npm ci
npm run build
node dist/launcher.js --offline \
  --research-core-entry /path/to/research_explorer_core/dist/service/cli.js
```

Inside Research Explorer:

```text
/research-doctor
/research-new My first research project
/research-status
/research-mode candidate
/research-next
/research-job-status
/research-plugin-search vision
/research-dependencies
/research-report ./project-report.md
```

Later runs use the saved Core discovery and recent Project automatically. Use `/research-open <project-id>` to switch Projects.

Manual mode preserves normal Pi chat. Candidate mode offers Core-issued next actions plus free chat, other input and cancel. Auto mode allows Core to execute at most one zero-cost, permission-free question action per turn and still stops for mandatory approval.

See the [command reference](docs/guides/command-reference.md) and [installation/recovery guide](docs/guides/installation-and-recovery.md).

After user-level installation of Core and CLI, `rexplore` starts from any directory without a Core path argument. Both packages can be updated independently.

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
