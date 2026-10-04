# ADR 005: Separate Pi packages from Core research plugins

- Status: accepted
- Date: 2026-10-05
- Stage: C4

## Decision

Research Explorer presents two distinct extension systems:

- Pi packages customize the terminal agent and remain managed by Pi `/packages`.
- Core research plugins contribute audited research capabilities and are managed through Core plugin contracts.

Plugin search and inspect are read-only static catalog operations. Lifecycle actions are slash commands with explicit confirmation. Install approval lists the exact content hash, permissions and side effects. Update computes the permission difference before mutation and uses a dedicated permission-expansion confirmation.

Project fork, Bundle v2 export/import and dependency inspection use public Core contracts. Bundle files are written atomically with mode `0600`; a defensive secret scan runs before export. Import confirms that SSH, OAuth and secret environment state will not be restored, then displays Core's compatibility and missing-dependency state.

## Consequences

- Model tools may search and inspect Core plugins but cannot install, enable, update or remove them.
- Catalog management never imports plugin extension code.
- Imported plugin locks preserve reproducibility while unavailable installations remain visibly missing or incompatible.
- Bundle import does not imply environment restoration.

