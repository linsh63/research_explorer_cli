import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectStatus } from "../core/types.js";
import type { ExecutionMode } from "../research/types.js";

export const RESEARCH_EXPLORER_ENTRY = "research-explorer.context";

export interface ResearchContextEntry {
  schemaVersion: 1;
  phase: "C4";
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  projectStatus: string;
  mode: ExecutionMode;
  conversationSessionId: string | null;
  jobIds: string[];
  activeJobId: string | null;
  recordedAt: string;
}

export function contextFromStatus(status: ProjectStatus, mode: ExecutionMode = "manual", conversationSessionId: string | null = null, jobIds: string[] = [], activeJobId: string | null = null): ResearchContextEntry {
  return {
    schemaVersion: 1,
    phase: "C4",
    workspaceId: status.workspaceId,
    projectId: status.project.id,
    projectTitle: status.project.title,
    projectStatus: status.project.status,
    mode,
    conversationSessionId,
    jobIds: [...new Set(jobIds)].slice(-100),
    activeJobId,
    recordedAt: new Date().toISOString(),
  };
}

export function restoreContext(entries: readonly unknown[]): ResearchContextEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type === "custom" && entry.customType === RESEARCH_EXPLORER_ENTRY) {
      const context = parseContext(entry.data);
      if (context) return context;
    }
  }
  return null;
}

export function readRecentContext(path: string): ResearchContextEntry | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return parseContext(value);
  } catch {
    return null;
  }
}

export function writeRecentContext(path: string, context: ResearchContextEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function parseContext(value: unknown): ResearchContextEntry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const base = item.schemaVersion === 1 && (item.phase === "C1" || item.phase === "C2" || item.phase === "C3" || item.phase === "C4" || item.phase === "C5") && typeof item.workspaceId === "string"
    && typeof item.projectId === "string" && typeof item.projectTitle === "string"
    && typeof item.projectStatus === "string" && typeof item.recordedAt === "string";
  if (!base) return null;
  const mode: ExecutionMode = item.mode === "candidate" || item.mode === "auto" ? item.mode : "manual";
  return {
    schemaVersion: 1,
    phase: "C4",
    workspaceId: item.workspaceId as string,
    projectId: item.projectId as string,
    projectTitle: item.projectTitle as string,
    projectStatus: item.projectStatus as string,
    mode,
    conversationSessionId: typeof item.conversationSessionId === "string" ? item.conversationSessionId : null,
    jobIds: Array.isArray(item.jobIds) ? item.jobIds.filter((entry): entry is string => typeof entry === "string").slice(-100) : [],
    activeJobId: typeof item.activeJobId === "string" ? item.activeJobId : null,
    recordedAt: item.recordedAt as string,
  };
}
