# C4 completion report

- Status: passed locally; Linux/macOS CI configured
- Completed: 2026-10-05
- Product version: `0.1.0-alpha.4`

## Delivered

- Static Core plugin search/inspect plus read-only `research_plugins` tool.
- Source add/refresh and install/enable/disable/update/remove user commands.
- Exact permission and side-effect approval, including separate permission-expansion confirmation.
- Clear Pi package versus Core research plugin language.
- Project fork, Bundle v2 export/import and dependency status commands.
- Atomic private Bundle files and defensive secret scan.

## Acceptance evidence

`npm run validate:c4` uses two independent real Core deployments. It proves catalog browsing, inspection, install and enable never execute fixture extension code; updating from 1.0.0 to 1.1.0 requires approval for added `network`; Bundle v2 contains the plugin lock; fork succeeds; a second deployment imports the Bundle and reports the absent Project-scoped plugin; SSH bindings, bearer tokens and private-key material are absent.

The machine-readable evidence is [`../validation/c4-validation.json`](../validation/c4-validation.json). The C0–C4 workflow runs all regression and real-Core gates on Ubuntu 24.04 and macOS 14.

