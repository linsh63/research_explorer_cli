# Security policy

Research Explorer is pre-release software. Report vulnerabilities privately through GitHub's security advisory flow for this repository.

## Trust boundaries

- Pi owns model credentials and conversation sessions.
- Auto Research Agent Core owns research state, approvals, jobs and artifacts.
- Research Explorer must use public Core contracts and must not open Core databases or storage paths.
- OAuth tokens, API keys, Core bearer or confirmation tokens, SSH private keys and sealed values must never be written to Pi custom entries, logs or bundles.
- Pi extensions execute code with the user's local permissions. Install only reviewed extensions and packages.
- C1 accepts only loopback Core HTTP. Its token file must be a protected regular file inside the configured Core data directory.
- Saved Project context is treated as unverified until the current Core Service confirms it after startup.
- Research write tools require explicit UI confirmation. Generic tool execution refuses scope approval and other mandatory human gates.
- Candidate, auto and tool paths all submit public Core ResearchAction contracts; CLI UI decisions do not replace Core authorization.
- Confirmation tokens are accepted only in the masked interactive TUI component, are cleared after submission and are never stored in Pi or CLI state.
- SSH setup accepts aliases and public fingerprints only; passwords, agents and private keys are not collected or forwarded.
- Core plugin lifecycle and Bundle import are user commands. Model tools can only search and inspect static plugin metadata.

Run `npm run check:boundaries`, `npm test`, `npm run validate:c0` and `npm audit --audit-level=high` before release.
