# ADR 004: Keep Jobs in Core and secrets transient

- Status: accepted
- Date: 2026-10-05
- Stage: C3

## Decision

Research Explorer stores only public Job IDs in its Project binding. Job state, logs, leases and Artifacts remain in Core. The CLI reconnects known nonterminal Jobs through Core SSE, resumes from the last log sequence and uses bounded exponential reconnect. CLI exit aborts only its stream; it never cancels the Core Job.

Job submission is a user slash command. Specs may come from an editor, inline JSON or an explicit `@file`; secret-like fields are rejected. Confirmation tokens are accepted only by a TUI custom component that renders bullets, clears its buffer on completion and passes the value once to `job.submit`. RPC, print and JSON modes refuse confirmation-token input.

Artifact displays omit internal `uri` values and show name, media type, size, access and content hash. The CLI does not read CAS paths.

SSH setup remains a user-only command sequence over public Core commands: add profile, probe, display fingerprint, explicit trusted-channel approval, re-probe, install, enable and attach. The CLI never accepts SSH passwords or private keys.

## Consequences

- Restart recovery is limited to the last 100 public Job IDs until Core publishes `job.list`.
- Existing Core Workers continue independently of the CLI.
- Remote Worker execution uses Core's already validated public SSH runtime; the CLI configures and observes it without copying SSH transport code.

