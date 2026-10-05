# Research Explorer command reference

## Project and interaction

- `/research-new <title>`
- `/research-open <project-id>`
- `/research-status`
- `/research-mode manual|candidate|auto`
- `/research-next [instruction]`
- `/research-fork <branch> <reason>`
- `/research-report <path>`

## Scientific capabilities

- `/research-capabilities`
- `/research-capability <capability-id> <input-json>`

The model has bounded `research_context`, `research_events`, `research_converse`, `research_choose_candidate`, `research_execute_action` and `research_capability` tools. Human-only gates remain enforced by Core.

## Jobs and remote execution

- `/research-job-submit <json|@file>`
- `/research-job-status [job-id]`
- `/research-job-logs [job-id]`
- `/research-job-cancel [job-id]`
- `/research-job-retry [job-id]`
- `/research-ssh-setup [host-alias]`
- `/research-ssh-status`

Confirmation tokens are accepted only by the interactive masked dialog.

## Core research plugins

- `/research-plugin-search [query]`
- `/research-plugin-inspect <descriptor-id>`
- `/research-plugin-source-add <kind> <location> [label]`
- `/research-plugin-source-refresh <source-id>`
- `/research-plugin-install <descriptor-id> [project|workspace]`
- `/research-plugin-enable|disable|remove <installation-id>`
- `/research-plugin-update <installation-id> <target-descriptor-id>`

Pi terminal packages remain managed by Pi `/packages`.

## Portability

- `/research-bundle-export <path> [embed|metadata]`
- `/research-bundle-import <path>`
- `/research-dependencies`

Bundle import does not restore SSH, OAuth, secret or plugin installation environment.

