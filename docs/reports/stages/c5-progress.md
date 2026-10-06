# C5 release-candidate report

- Status: stable release passed on Linux x64, macOS arm64 and macOS x64
- Completed locally: 2026-10-05
- Release: `0.2.0`

## Delivered

- Public scientific capability catalog/invocation and a fact-bound report command.
- Real CLI Project path from creation, question proposal/selection and explicit scope approval to scientific-writing report.
- Pi print and JSON automation compatibility; RPC retained only for acceptance/debugging.
- Session tree, clone, fork and automatic-compaction control regression.
- Package-only installation, license/notices, local documentation-link and secret gates.
- Real package upgrade from `0.1.2` to `0.2.0` and rollback to `0.1.2` using the same saved state.
- Installation, permissions, offline, upgrade and recovery guides.
- User-prefix installer that installs independently versioned `research-explorer-core` and `research-explorer-cli` packages from npm, with a public HTTPS repository fallback.
- Unified Core package and executable naming, with legacy executable discovery retained for existing installations.
- Pi session selection plus a public Core Project picker at startup.
- Session-scoped Project binding without global recent-Project inheritance.
- Compact commands, quiet manual mode, localized stages and detailed model-generated direction choices.

## Local evidence

[`../validation/c5-release-audit.json`](../validation/c5-release-audit.json) records the deterministic Linux audit. It makes no model call and performs no publication action.

After the Core repository rename, the final workflow passed 4/4 for commit `ae3186b`: Ubuntu 24.04, macOS 15 arm64, macOS 15 Intel and a clean user-prefix installation job against `linsh63/research_explorer_core`. The recorded evidence is [`../validation/c5-ci.json`](../validation/c5-ci.json).

[`../validation/user-installation-e2e.json`](../validation/user-installation-e2e.json) records a clean user-prefix installation from GitHub, Core auto-start from an unrelated working directory, and independent Core-only/CLI-only updates.

## Known limits

- `workspace.projects`, `job.list` and `artifact.export` remain public Core API gaps; the CLI uses explicit Project IDs, saved Job IDs and Artifact metadata.
- Starting a persistent SSH Worker controller is a deployment operation outside the current Core Service endpoint set.
- The fact-bound C5 report proves the complete CLI/Core path; it is a Project summary, not a claim of completed empirical science.
