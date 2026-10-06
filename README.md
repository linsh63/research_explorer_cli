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

C0 through C5 are complete. Version `0.2.0` adds a startup session/project picker, session-scoped Project binding, compact commands, a quiet manual mode, human-readable stages and model-generated candidate directions after each answer.

Existing `auto-research-agent` installations must remove the deprecated package before installing the renamed Core because both packages expose compatibility command names:

```bash
npm uninstall -g --prefix "$HOME/.local" auto-research-agent
npm install -g --prefix "$HOME/.local" research-explorer-core research-explorer-cli
```

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
/doctor
/project
/status
/mode candidate
/next
/actions
/research-job-status
/research-plugin-search vision
/research-dependencies
/report ./project-report.md
```

An interactive `rexplore` launch opens Pi's session selector. A fresh chat then offers existing Core Projects, a new Project, or unbound free chat. Use `/project` to switch later.

Manual mode preserves normal Pi chat and hides research status. Candidate mode lets Pi answer normally, then generates detailed direction cards with a goal, next step and rationale. `/actions` separately shows Core-issued legal state transitions. Auto mode allows Core to execute at most one zero-cost, permission-free question action per turn and still stops for mandatory approval.

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
