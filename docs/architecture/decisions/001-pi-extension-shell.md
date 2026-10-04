# ADR 001: Use Pi as the interactive shell

- Status: accepted
- Date: 2026-10-04
- Stage: C0

## Context

Research Explorer needs a terminal chat interface with streaming, cancellation, sessions, model authentication, tools, skills and extension points. Rebuilding those facilities would create a second agent runtime and make the research client harder to maintain.

## Decision

Research Explorer uses the official `@earendil-works/pi-coding-agent` CLI as its interactive shell. The `rexplore` executable is a thin launcher that resolves Pi's packaged CLI, loads the Research Explorer extension with `--extension`, passes all user arguments through and returns Pi's exit status.

Research features are added through documented Pi extension APIs: commands, tools, input and lifecycle events, custom entries and renderers. Product code does not copy Pi's TUI or agent loop. Research state remains owned by the separately deployed Auto Research Agent Core and will be accessed only through public contracts.

The implementation pins Pi and Pi TUI to `1.0.2`. The draft plan named `0.85.1`; dependency audit found known high severity issues in that dependency graph. Pi `1.0.2` removes those findings and passed the C0 extension, RPC lifecycle and package-only checks. Core was not modified by this dependency decision.

## Alternatives considered

1. Fork Pi and maintain a branded CLI. Rejected because it duplicates upstream maintenance and complicates upgrades.
2. Build a new interactive loop with Ink, React, Blessed or a command parser. Rejected because it repeats mature Pi behavior and introduces competing session semantics.
3. Build the full UI with the Pi SDK. Reserved for focused tests; it still requires Research Explorer to own an interactive loop.

## Consequences

- Pi upgrades are explicit compatibility changes and must pass the package and session regression suite.
- `rexplore` remains small; most CLI work belongs in extension modules.
- Pi sessions store conversation state and non-sensitive project bindings. Core owns research actions, approvals, jobs and artifacts.
- The launcher relies on Pi's packaged CLI entry. C0 fails clearly if that entry is absent.

