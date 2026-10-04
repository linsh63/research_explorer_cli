import { randomUUID } from "node:crypto";
import type { CoreConnection } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchOperationError } from "./runtime.js";

export interface SshProfile { id: string; name: string; hostAlias: string; remoteRoot: string; expectedArch: string | null; status: string; pendingFingerprint: string | null; approvedFingerprint: string | null }
export interface SshInstallation { id: string; profileId: string; status: string; contentHash: string; remotePath: string }
export interface SshPreflight { profileId: string; fingerprint: string; trusted: boolean; issues: string[]; remotePlatform: { os: "linux"; arch: string; nodeVersion: string | null } | null }

export class SshRuntime {
  constructor(private readonly client: CoreConnection, readonly workspaceId: string, readonly projectId: string) {}

  async profiles(): Promise<{ profiles: SshProfile[]; installations: SshInstallation[] }> { return this.query("ssh.profiles", null, {}); }
  async project(): Promise<{ requirements: unknown[] }> { return this.query("ssh.project", this.projectId, {}); }
  async addProfile(payload: { name: string; hostAlias: string; sshConfigFile: string | null; remoteRoot: string; expectedArch: string | null }): Promise<SshProfile> { return (await this.execute<{ profile: SshProfile }>("ssh.profile.add", null, payload)).profile; }
  async probe(profileId: string): Promise<SshPreflight> { return (await this.execute<{ preflight: SshPreflight }>("ssh.profile.probe", null, { profileId })).preflight; }
  async approve(profileId: string, fingerprint: string): Promise<SshProfile> { return (await this.execute<{ profile: SshProfile }>("ssh.host.approve", null, { profileId, fingerprint })).profile; }
  async install(profileId: string): Promise<SshInstallation> { return (await this.execute<{ installation: SshInstallation }>("ssh.worker.install", null, { profileId })).installation; }
  async enable(installationId: string): Promise<SshInstallation> { return (await this.execute<{ installation: SshInstallation }>("ssh.worker.enable", null, { installationId })).installation; }
  async attach(profileId: string, installationId: string): Promise<unknown> { return (await this.execute<{ requirement: unknown }>("ssh.project.attach", this.projectId, { profileId, installationId })).requirement; }

  private async query<T>(type: string, projectId: string | null, payload: Record<string, unknown>): Promise<T> {
    const result = await this.client.query<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, queryId: `cli-${randomUUID()}`, type, workspaceId: this.workspaceId, projectId, actor: actor(), ...payload });
    if (result.status !== "ok" || result.data === null) throw operationError(result.error, `${type} query failed`);
    return result.data;
  }
  private async execute<T>(type: string, projectId: string | null, payload: unknown): Promise<T> {
    const id = randomUUID();
    const result = await this.client.execute<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, commandId: `cli-${id}`, idempotencyKey: `cli-${id}`, type, workspaceId: this.workspaceId, projectId, actor: actor(), issuedAt: new Date().toISOString(), payload });
    if (result.status !== "accepted" || result.data === null) throw operationError(result.error, `${type} command failed`);
    return result.data;
  }
}

function actor() { return { id: "user:research-explorer", kind: "user", displayName: "Research Explorer user" } as const; }
function operationError(error: { code: string; message: string } | null, fallback: string) { return new ResearchOperationError(error?.message ?? fallback, error?.code ?? "INTERNAL"); }
