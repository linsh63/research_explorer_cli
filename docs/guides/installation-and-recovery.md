# Installation, upgrade and recovery

## Requirements

- Node.js 22.19 or newer;
- Linux x64, macOS arm64 or macOS x64;
- separately installed Auto Research Agent Core compatible with service/schema `1.0.0`.

## Recommended user installation

Install both independently versioned packages without administrator permissions:

```bash
npm install -g --prefix "$HOME/.local" \
  research-explorer-core research-explorer-cli
export PATH="$HOME/.local/bin:$PATH"
rexplore
```

This places `research-explorer-core` and `rexplore` in the same user PATH, so `rexplore` discovers and starts Core automatically from any working directory. The legacy `auto-research-core` command remains a temporary compatibility alias.

When migrating an existing user-prefix installation, remove the deprecated package first to avoid npm command-link collisions. The repository installer detects and performs this migration automatically:

```bash
npm uninstall -g --prefix "$HOME/.local" auto-research-agent
npm install -g --prefix "$HOME/.local" research-explorer-core research-explorer-cli
```

The repository installer wraps the same npm installation and supports independent updates:

```bash
git clone https://github.com/linsh63/research_explorer_cli.git
cd research_explorer_cli
bash scripts/install-user.sh
```

Use `bash scripts/install-user.sh --git` to build directly from the two public GitHub repositories. Manual source packaging is also available:

```bash
git clone https://github.com/linsh63/research_explorer_core.git
cd research_explorer_core && npm ci && npm pack
npm install -g --prefix "$HOME/.local" ./research-explorer-core-*.tgz

git clone https://github.com/linsh63/research_explorer_cli.git
cd research_explorer_cli && npm ci && npm pack
npm install -g --prefix "$HOME/.local" ./research-explorer-cli-*.tgz
export PATH="$HOME/.local/bin:$PATH"
rexplore
```

During development, build Core and pass its public executable:

```bash
rexplore --research-core-entry /path/to/research_explorer_core/dist/service/cli.js
```

Research Explorer defaults to `~/.research-explorer`. Core credentials stay in Core's protected data directory; Pi model credentials stay in Pi.

## Independent updates

Update only Core from npm:

```bash
cd research_explorer_cli
bash scripts/install-user.sh --core-only
```

Update only the CLI from npm:

```bash
bash scripts/install-user.sh --cli-only
```

Pin npm versions with `RESEARCH_CORE_VERSION` and `RESEARCH_EXPLORER_VERSION`, or use `--git` with `RESEARCH_CORE_REF` and `RESEARCH_EXPLORER_REF` for reproducible source commits.

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

Research Explorer `0.1.2` writes the same CLI state shape as `0.1.0`; package rollback can reopen saved Project and Job IDs. Version `0.1.2` migrates the default Core package name while retaining discovery of the old executable as a compatibility fallback.

CLI rollback does not downgrade a Core database. If Core was upgraded and migrated, stop Core and restore its pre-upgrade backup before running an older Core version.

## Offline and degraded operation

- Pi `--offline` prevents optional resource downloads.
- Core without `network` permission remains offline and can use deterministic capabilities and supported local executors.
- If Core is unavailable, saved Project data is marked unverified and is not injected as current fact.
- CLI exit never cancels a persistent Job.
- If an SSH Worker is unavailable, Job state remains in Core and stale leases cannot mutate a later attempt.
