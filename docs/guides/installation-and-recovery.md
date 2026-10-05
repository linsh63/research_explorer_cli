# Installation, upgrade and recovery

## Requirements

- Node.js 22.19 or newer;
- Linux x64, macOS arm64 or macOS x64;
- separately installed Auto Research Agent Core compatible with service/schema `1.0.0`.

## Recommended user installation

Clone the small CLI repository, inspect the installer, then install both independently versioned packages without administrator permissions:

```bash
git clone https://github.com/linsh63/research_explorer_cli.git
cd research_explorer_cli
bash scripts/install-user.sh
export PATH="$HOME/.local/bin:$PATH"
rexplore
```

The installer obtains Core and CLI from their public Git repositories. Both packages build during Git installation and place `auto-research-core` and `rexplore` in the same user PATH. `rexplore` therefore discovers and starts Core automatically from any working directory.

Equivalent manual installation:

```bash
npm install -g --prefix "$HOME/.local" \
  git+https://github.com/linsh63/auto_research_agent.git#main
npm install -g --prefix "$HOME/.local" \
  git+https://github.com/linsh63/research_explorer_cli.git#main
export PATH="$HOME/.local/bin:$PATH"
rexplore
```

During development, build Core and pass its public executable:

```bash
rexplore --research-core-entry /path/to/auto-research-agent/dist/service/cli.js
```

Research Explorer defaults to `~/.research-explorer`. Core credentials stay in Core's protected data directory; Pi model credentials stay in Pi.

## Independent updates

Update only Core:

```bash
cd research_explorer_cli
bash scripts/install-user.sh --core-only
```

Update only the CLI:

```bash
bash scripts/install-user.sh --cli-only
```

Pin reproducible Git commits with `RESEARCH_CORE_REF` and `RESEARCH_EXPLORER_REF`. When registry publication becomes available, the same independent layout supports separate `npm update -g` operations.

## Explicit Core permissions

Local research interaction uses Core defaults. SSH or unrestricted Python work requires an explicit allowlist when Core is first started:

```bash
rexplore \
  --research-core-permissions filesystem.read,filesystem.write,process,confirmation,network
```

Enabling a permission only allows the service to evaluate corresponding commands. Core command, research, capability and human gates still apply.

## Upgrade

1. Stop active CLI sessions. Persistent Core Jobs may continue.
2. Back up Core database, Artifact storage and Core configuration according to the Core migration guide.
3. Install the new Research Explorer package.
4. Run `/research-doctor`, `/research-status` and `/research-job-status`.
5. Review compatibility and missing plugin/Artifact dependencies before executing new work.

## Rollback

Research Explorer `0.1.0-rc.1` writes the same CLI state shape as `0.1.0-alpha.4`; package rollback can reopen saved Project and Job IDs. Install the earlier package and run doctor/status again.

CLI rollback does not downgrade a Core database. If Core was upgraded and migrated, stop Core and restore its pre-upgrade backup before running an older Core version.

## Offline and degraded operation

- Pi `--offline` prevents optional resource downloads.
- Core without `network` permission remains offline and can use deterministic capabilities and supported local executors.
- If Core is unavailable, saved Project data is marked unverified and is not injected as current fact.
- CLI exit never cancels a persistent Job.
- If an SSH Worker is unavailable, Job state remains in Core and stale leases cannot mutate a later attempt.
