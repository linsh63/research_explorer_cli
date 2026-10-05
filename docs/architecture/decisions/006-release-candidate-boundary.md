# ADR 006: Treat v0.1 as a release candidate without publishing

- Status: accepted
- Date: 2026-10-05
- Stage: C5

## Decision

Version `0.1.0-rc.1` is the first product release candidate. C5 validates source, packed npm artifact, public Core workflows and supported native platforms. It does not create a Git tag, GitHub Release or npm publication; those actions require a separate user instruction.

Pi remains the owner of chat, model authentication, skills, sessions, tree navigation, fork/clone and compaction. Research Explorer tests those public surfaces and does not wrap them in a second protocol. RPC is used only by automated acceptance; user automation uses Pi print or JSON modes.

Persistent Research Explorer state remains schema-compatible with `0.1.0-alpha.4`, so downgrade can reopen Project and Job identifiers. Core database rollback follows Core's backup policy and is outside the CLI package.

## Release gates

- exact Pi/Core/public-schema compatibility metadata;
- package-only install with required license/security notices;
- upgrade and rollback package smoke;
- Linux x64, macOS arm64 and macOS x64 native matrix;
- a real public-Core Project from creation through fact-bound report;
- secret, credential, permission and Bundle isolation checks;
- no Core internal imports, database reads, copied Pi loop or copied TUI.

