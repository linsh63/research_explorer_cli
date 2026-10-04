# C0 completion report

- Status: passed
- Completed: 2026-10-04
- Product: Research Explorer CLI
- Command: `rexplore`

## Delivered

- Created an independent npm package and repository.
- Implemented a thin launcher around the packaged Pi CLI with argument and exit status propagation.
- Implemented a bounded Pi extension with one diagnostic command, one diagnostic tool, input routing, prompt context, session lifecycle status, a custom entry and renderer.
- Pinned Pi and Pi TUI to audited version `1.0.2` and recorded the decision in ADR 001.
- Declared compatibility with Pi `1.0.2`, Core Service `1.0.0` and public schema `1.0.0` in package metadata.
- Added a source boundary gate that rejects Core internals, database access and replacement CLI/TUI dependencies.
- Added unit tests and a package-only acceptance test.
- Recorded Core public API gaps without changing the Core repository.

## Acceptance evidence

`npm run validate:c0` drives the real Pi RPC runtime through `rexplore` and verifies:

1. the extension command is discovered and handled;
2. a non-sensitive custom entry is appended to a persistent Pi session;
3. the process acknowledges the cancellation command;
4. a fresh process resumes the same session and restores the custom entry;
5. `npm pack` output installs in a clean consumer directory;
6. the installed `rexplore` binary loads the pinned Pi and extension.

The repository keeps the machine-readable result in [`../validation/c0-validation.json`](../validation/c0-validation.json). This changing evidence file is excluded from the npm artifact so its embedded tarball digest remains reproducible. Unit tests cover command/tool registration, ordinary chat pass-through, extension recursion prevention, honest prompt injection and secret exclusion. `npm audit --audit-level=high` reports zero vulnerabilities.

A Linux PTY smoke test also launched the real interactive TUI in offline, in-memory mode, displayed the Research Explorer widget/status, ran `/research-about`, rendered the custom entry and exited cleanly without a model call.

## Scope and limitations

- No Core service was connected and no Core state was claimed.
- No model request or credential was needed.
- Automated integration used Pi's real RPC mode. The extension and launcher are the same artifacts used by the interactive TUI; native interactive and macOS matrices remain later release gates.
- Core public read models listed in [`../../core-api-gaps.md`](../../core-api-gaps.md) remain external prerequisites for full project navigation.

## Result

C0's architecture is viable: Research Explorer can extend and package Pi without implementing a terminal UI or agent loop. C1 may build launcher discovery and project context on this boundary after the required public Core capabilities are available.
