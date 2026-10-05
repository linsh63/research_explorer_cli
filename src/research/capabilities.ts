import { randomUUID } from "node:crypto";
import type { CoreConnection } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchOperationError } from "./runtime.js";

export interface CapabilityDescriptor { id: string; version: string; description: string; operations: string[]; sideEffects: string[] }

export class CapabilityRuntime {
  constructor(private readonly client: CoreConnection, readonly workspaceId: string, readonly projectId: string) {}
  async catalog(): Promise<CapabilityDescriptor[]> { return (await this.query<{ capabilities: CapabilityDescriptor[] }>("capability.catalog", {})).capabilities; }
  async invoke(capability: string, input: unknown, actorKind: "user" | "agent"): Promise<any> { return this.execute("capability.invoke", { capability, input }, actorKind); }
  private async query<T>(type: string, payload: Record<string, unknown>): Promise<T> { const result = await this.client.query<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, queryId: `cli-${randomUUID()}`, type, workspaceId: this.workspaceId, projectId: this.projectId, actor: actor("user"), ...payload }); if (result.status !== "ok" || result.data === null) throw operationError(result.error, `${type} query failed`); return result.data; }
  private async execute<T>(type: string, payload: unknown, actorKind: "user" | "agent"): Promise<T> { const id = randomUUID(); const result = await this.client.execute<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, commandId: `cli-${id}`, idempotencyKey: `cli-${id}`, type, workspaceId: this.workspaceId, projectId: this.projectId, actor: actor(actorKind), issuedAt: new Date().toISOString(), payload }); if (result.status !== "accepted" || result.data === null) throw operationError(result.error, `${type} command failed`); return result.data; }
}
function actor(kind: "user" | "agent") { return kind === "user" ? { id: "user:research-explorer", kind, displayName: "Research Explorer user" } : { id: "agent:research-explorer", kind, displayName: "Research Explorer agent" }; }
function operationError(error: { code: string; message: string } | null, fallback: string) { return new ResearchOperationError(error?.message ?? fallback, error?.code ?? "INTERNAL"); }
