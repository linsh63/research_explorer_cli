import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CoreConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export function registerCoreFlags(pi: ExtensionAPI): void {
  pi.registerFlag("research-core-data-dir", { type: "string", description: "Core Service discovery directory" });
  pi.registerFlag("research-core-database", { type: "string", description: "Core Service database path" });
  pi.registerFlag("research-core-entry", { type: "string", description: "auto-research-core executable or JS entry" });
  pi.registerFlag("research-no-core-autostart", { type: "boolean", description: "Only attach to an existing Core Service" });
  pi.registerFlag("research-workspace", { type: "string", description: "Default research Workspace ID" });
  pi.registerFlag("research-state-file", { type: "string", description: "Non-sensitive recent Project state file" });
}

export function resolveCoreConfig(pi: Pick<ExtensionAPI, "getFlag">, env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const productDir = resolve(env.RESEARCH_EXPLORER_HOME ?? join(homedir(), ".research-explorer"));
  const dataDir = resolve(stringFlag(pi, "research-core-data-dir") ?? env.RESEARCH_EXPLORER_CORE_DATA_DIR ?? join(productDir, "core"));
  const timeout = Number(env.RESEARCH_EXPLORER_CORE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return {
    dataDir,
    databasePath: resolve(stringFlag(pi, "research-core-database") ?? env.RESEARCH_EXPLORER_CORE_DATABASE ?? join(dataDir, "research.db")),
    serviceEntry: stringFlag(pi, "research-core-entry") ?? env.RESEARCH_EXPLORER_CORE_ENTRY,
    autoStart: pi.getFlag("research-no-core-autostart") !== true,
    timeoutMs: Number.isFinite(timeout) && timeout >= 500 && timeout <= 120_000 ? timeout : DEFAULT_TIMEOUT_MS,
    workspaceId: stringFlag(pi, "research-workspace") ?? env.RESEARCH_EXPLORER_WORKSPACE ?? "workspace:default",
    stateFile: resolve(stringFlag(pi, "research-state-file") ?? env.RESEARCH_EXPLORER_STATE_FILE ?? join(productDir, "state.json")),
  };
}

function stringFlag(pi: Pick<ExtensionAPI, "getFlag">, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

