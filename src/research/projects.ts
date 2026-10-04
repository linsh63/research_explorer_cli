import { randomUUID } from "node:crypto";
import type { CoreConnection } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchOperationError } from "./runtime.js";

export class ProjectRuntime {
  constructor(private readonly client: CoreConnection, readonly workspaceId: string, readonly projectId: string) {}
  async fork(branchName: string, reason: string): Promise<any> { return this.execute("project.fork", this.projectId, { branchName, reason }); }
  exportBundle(artifactPolicy: "embed" | "metadata" = "embed", maxEmbeddedBytes = 20_000_000): Promise<any> { return this.query("project.bundle", this.projectId, { bundleVersion: "2", artifactPolicy, maxEmbeddedBytes }); }
  dependencies(): Promise<any> { return this.query("project.dependencies", this.projectId, {}); }
  async importBundle(bundle: unknown): Promise<any> { return this.execute("project.import", null, { bundle }); }
  private async query<T>(type: string, projectId: string | null, payload: Record<string, unknown>): Promise<T> { const result = await this.client.query<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, queryId: `cli-${randomUUID()}`, type, workspaceId: this.workspaceId, projectId, actor: actor(), ...payload }); if (result.status !== "ok" || result.data === null) throw operationError(result.error, `${type} query failed`); return result.data; }
  private async execute<T>(type: string, projectId: string | null, payload: unknown): Promise<T> { const id = randomUUID(); const result = await this.client.execute<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, commandId: `cli-${id}`, idempotencyKey: `cli-${id}`, type, workspaceId: this.workspaceId, projectId, actor: actor(), issuedAt: new Date().toISOString(), payload }); if (result.status !== "accepted" || result.data === null) throw operationError(result.error, `${type} command failed`); return result.data; }
}
function actor() { return { id: "user:research-explorer", kind: "user", displayName: "Research Explorer user" } as const; }
function operationError(error: { code: string; message: string } | null, fallback: string) { return new ResearchOperationError(error?.message ?? fallback, error?.code ?? "INTERNAL"); }
