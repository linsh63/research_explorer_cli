# Security policy

Research Explorer is pre-release software. Report vulnerabilities privately through GitHub's security advisory flow for this repository.

## Trust boundaries

- Pi owns model credentials and conversation sessions.
- Auto Research Agent Core owns research state, approvals, jobs and artifacts.
- Research Explorer must use public Core contracts and must not open Core databases or storage paths.
- OAuth tokens, API keys, Core bearer or confirmation tokens, SSH private keys and sealed values must never be written to Pi custom entries, logs or bundles.
- Pi extensions execute code with the user's local permissions. Install only reviewed extensions and packages.

Run `npm run check:boundaries`, `npm test`, `npm run validate:c0` and `npm audit --audit-level=high` before release.

