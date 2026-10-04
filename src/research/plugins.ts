import { randomUUID } from "node:crypto";
import type { CoreConnection } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchOperationError } from "./runtime.js";

export interface PluginDescriptor { descriptorId: string; pluginId: string; name: string; version: string; description: string; domain: string[]; license: string; maintainers: string[]; sourceId: string; sourceKind: string; sourceLocation: string; contentHash: string; contributions: Record<string, string[]>; permissions: string[]; sideEffects: string[]; dependencies: string[]; coreSchemaRange: string; piVersionRange: string; compatibilityStatus: "compatible" | "incompatible"; compatibilityIssues: string[] }
export interface PluginInstallation { id: string; workspaceId: string; projectId: string | null; scope: "project" | "workspace"; pluginId: string; version: string; contentHash: string; descriptorId: string; status: string; approvedPermissions: string[]; updatedAt: string }

export class PluginRuntime {
  constructor(private readonly client: CoreConnection, readonly workspaceId: string, readonly projectId: string) {}
  async search(query = ""): Promise<PluginDescriptor[]> { return (await this.query<{ plugins: PluginDescriptor[] }>("plugin.search", null, { query, filters: { compatibleOnly: false } })).plugins; }
  async inspect(descriptorId: string): Promise<PluginDescriptor> { return (await this.query<{ plugin: PluginDescriptor }>("plugin.inspect", null, { descriptorId })).plugin; }
  async installations(): Promise<PluginInstallation[]> { return (await this.query<{ installations: PluginInstallation[] }>("plugin.installations", this.projectId, {})).installations; }
  async addSource(kind: "local" | "git" | "npm" | "pi_config", location: string, label: string): Promise<any> { return (await this.execute<any>("plugin.source.add", null, { kind, location, label })).source; }
  async refreshSource(sourceId: string): Promise<any> { return this.execute("plugin.source.refresh", null, { sourceId }); }
  async install(descriptor: PluginDescriptor, scope: "project" | "workspace"): Promise<PluginInstallation> { return (await this.execute<{ installation: PluginInstallation }>("plugin.install", scope === "project" ? this.projectId : null, { descriptorId: descriptor.descriptorId, scope, approvedPermissions: descriptor.permissions })).installation; }
  async enable(installation: PluginInstallation): Promise<PluginInstallation> { return (await this.execute<{ installation: PluginInstallation }>("plugin.enable", installation.projectId, { installationId: installation.id })).installation; }
  async disable(installation: PluginInstallation): Promise<PluginInstallation> { return (await this.execute<{ installation: PluginInstallation }>("plugin.disable", installation.projectId, { installationId: installation.id })).installation; }
  async remove(installation: PluginInstallation): Promise<PluginInstallation> { return (await this.execute<{ installation: PluginInstallation }>("plugin.remove", installation.projectId, { installationId: installation.id })).installation; }
  async update(installation: PluginInstallation, target: PluginDescriptor): Promise<{ installation: PluginInstallation; permissionDiff: { added: string[]; removed: string[]; unchanged: string[] } }> { return this.execute("plugin.update", installation.projectId, { installationId: installation.id, targetDescriptorId: target.descriptorId, approvedPermissions: target.permissions }); }
  async findInstallation(id: string): Promise<PluginInstallation> { const item = (await this.installations()).find((entry) => entry.id === id); if (!item) throw new ResearchOperationError(`Unknown plugin installation ${id}`, "NOT_FOUND"); return item; }

  private async query<T>(type: string, projectId: string | null, payload: Record<string, unknown>): Promise<T> { const result = await this.client.query<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, queryId: `cli-${randomUUID()}`, type, workspaceId: this.workspaceId, projectId, actor: actor(), ...payload }); if (result.status !== "ok" || result.data === null) throw operationError(result.error, `${type} query failed`); return result.data; }
  private async execute<T>(type: string, projectId: string | null, payload: unknown): Promise<T> { const id = randomUUID(); const result = await this.client.execute<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, commandId: `cli-${id}`, idempotencyKey: `cli-${id}`, type, workspaceId: this.workspaceId, projectId, actor: actor(), issuedAt: new Date().toISOString(), payload }); if (result.status !== "accepted" || result.data === null) throw operationError(result.error, `${type} command failed`); return result.data; }
}

function actor() { return { id: "user:research-explorer", kind: "user", displayName: "Research Explorer user" } as const; }
function operationError(error: { code: string; message: string } | null, fallback: string) { return new ResearchOperationError(error?.message ?? fallback, error?.code ?? "INTERNAL"); }
