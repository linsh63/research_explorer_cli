# C1 completion report

- Status: passed on Linux and macOS
- Completed: 2026-10-04
- Product version: `0.1.0-alpha.1`

## Delivered

- Core discovery, loopback attach, protected token resolution, health and exact service/schema negotiation.
- Core auto-start through `auto-research-core` or `--research-core-entry`.
- `/research-doctor`, `/research-new`, `/research-open <project-id>` and `/research-status`.
- Project binding in Pi custom session entries plus a non-sensitive recent-state file.
- Mandatory Core refresh after restore; offline bindings remain visibly unverified.
- Project title, status, Workspace and ID in Pi title/footer/widget.
- Bounded C1 context for the Pi agent without research action tools, which begin in C2.

## Acceptance evidence

`npm run validate:c1` uses the real Pi RPC runtime and real Core Service to:

1. auto-start Core and run doctor;
2. create a Project through the public command endpoint;
3. persist its binding in Pi and recent state;
4. stop Core, restart it against the same database and refresh Project status;
5. resume the same Pi session;
6. verify the exact bearer token is absent from both persistence files;
7. install the packed CLI into a clean consumer directory and attach to Core again.

The machine-readable Linux result is [`../validation/c1-validation.json`](../validation/c1-validation.json). The workflow [`.github/workflows/c1.yml`](../../../.github/workflows/c1.yml) ran the same real-Core gate on Ubuntu 24.04 and macOS 14; both jobs passed for commit `132ac55`. The recorded run is in [`../validation/c1-ci.json`](../validation/c1-ci.json). Core's earlier v1.6 platform release already validates its public Project path on both systems; this workflow adds the Research Explorer package and Pi extension path.

Unit coverage verifies the command surface, creation/binding, recent-state recovery, Core refresh, honest empty context and fail-closed degraded restoration. C0 remains green as a regression gate.

## Boundary decisions

- Core is an independently installed service and is not bundled into the CLI package.
- No Core internal import or database access is present.
- `/research-open` requires a Project ID because `workspace.projects` is still a tracked public API gap.
- Core remains running after `rexplore` exits so later sessions and background work can attach.

## Result

C1 supplies a usable Project shell: users can start Research Explorer, create or open a Project, inspect status and resume it after both CLI and Core restarts. Research conversations and action execution remain C2 scope.
