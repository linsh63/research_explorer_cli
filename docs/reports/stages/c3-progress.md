# C3 completion report

- Status: passed on Linux and macOS
- Completed: 2026-10-05
- Included in product version: `0.1.0-alpha.4`

## Delivered

- Persistent Job submission, status, bounded logs, cancellation and retry commands.
- `research_job` read/cancel tool with explicit cancellation confirmation.
- SSE Job/event monitor with last-sequence resume and bounded reconnect.
- Restart recovery from public Job IDs, without `job.list` or database access.
- Artifact display without internal CAS URI exposure.
- TUI-only masked confirmation-token input and rejection in headless modes.
- SSH profile/trust/install/enable/attach wizard and status command.

## Acceptance evidence

`npm run validate:c3` uses real Pi RPC, Core Service, a public local Worker and the public Worker protocol. It verifies CLI exit does not cancel a queued Job, a Worker completes it afterward, a new CLI restores status/logs/Artifact, queued cancellation succeeds, retry creates attempt 2 and attempt 1's stale lease is rejected. Token values remain absent from Pi and recent state.

The Linux evidence is [`../validation/c3-validation.json`](../validation/c3-validation.json). Linux additionally runs a real Python Worker; macOS completes the same lifecycle through the public Worker protocol, avoiding a second in-process Core database owner. Unit coverage verifies hidden rendering and that headless confirmation submission cannot reach Core. The two-platform run is recorded in [`../validation/c4-ci.json`](../validation/c4-ci.json). Core's v1.6 Z evidence remains the physical macOS-to-Linux SSH execution gate; C3 exercises the CLI's same public setup contracts without requiring a shared CI SSH host.

## Limitation

Core does not expose a service endpoint that starts an SSH Worker loop. Research Explorer attaches a validated Worker installation; deployment still starts the Core public Worker controller separately. The CLI does not duplicate that runtime.
