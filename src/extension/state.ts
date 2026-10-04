import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectStatus } from "../core/types.js";

export const RESEARCH_EXPLORER_ENTRY = "research-explorer.context";

export interface ResearchContextEntry {
  schemaVersion: 1;
  phase: "C1";
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  projectStatus: string;
  recordedAt: string;
}

export function contextFromStatus(status: ProjectStatus): ResearchContextEntry {
  return {
    schemaVersion: 1,
    phase: "C1",
    workspaceId: status.workspaceId,
    projectId: status.project.id,
    projectTitle: status.project.title,
    projectStatus: status.project.status,
    recordedAt: new Date().toISOString(),
  };
}

export function restoreContext(entries: readonly unknown[]): ResearchContextEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type === "custom" && entry.customType === RESEARCH_EXPLORER_ENTRY && isContext(entry.data)) return entry.data;
  }
  return null;
}

export function readRecentContext(path: string): ResearchContextEntry | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return isContext(value) ? value : null;
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

function isContext(value: unknown): value is ResearchContextEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ResearchContextEntry>;
  return item.schemaVersion === 1 && item.phase === "C1" && typeof item.workspaceId === "string"
    && typeof item.projectId === "string" && typeof item.projectTitle === "string"
    && typeof item.projectStatus === "string" && typeof item.recordedAt === "string";
}
