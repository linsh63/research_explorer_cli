# ADR 002: Connect through Core discovery and public HTTP contracts

- Status: accepted
- Date: 2026-10-04
- Stage: C1

## Context

Research Explorer and Auto Research Agent Core are independently deployed projects. The Core npm package is not published yet, so a package dependency would either use an unpublished name or bind the CLI to a developer checkout. C1 still needs local attach, auto-start, version negotiation and Project commands.

## Decision

Research Explorer uses Core's public local-service boundary:

1. read `core-service.json` from the configured Core data directory;
2. accept only loopback HTTP during C1;
3. resolve the bearer credential from Core's protected token file or named environment secret;
4. negotiate exact Core Service and public schema version `1.0.0`;
5. use `/v1/health`, `/v1/capabilities`, `/v1/commands` and `/v1/queries`;
6. auto-start the public `research-explorer-core` executable, with `auto-research-core` as a compatibility fallback, or use an explicitly configured packaged JS entry when discovery is absent;
7. keep the Core process alive when the CLI exits.

Loopback requests use Node's native HTTP client so global model-provider proxy settings cannot redirect or block local Core traffic. The token file must be a regular, non-symlink file within the configured Core data directory and must deny group/other access on POSIX systems.

The CLI stores only Workspace ID, Project ID, display title/status and timestamp in Pi custom entries and its recent-state file. A restored binding is marked unverified until Core confirms it after every CLI start.

## Consequences

- CLI packages install without a Core source checkout.
- Users install Core separately or pass `--research-core-entry` during development.
- No Core domain, application, storage or migration module is imported.
- C1 `/research-open` accepts an explicit Project ID until Core publishes `workspace.projects`.
- The public SDK can replace the small HTTP adapter after the Core package is published without changing extension commands.
