import { randomUUID } from "node:crypto";
import type { CoreConnection, CoreStreamEvent } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchOperationError } from "./runtime.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  status: JobStatus;
  spec: Record<string, unknown>;
  currentAttempt: number;
  cancelRequested: boolean;
  failureClass: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobArtifact {
  id: string;
  jobId: string;
  attempt: number;
  name: string;
  mediaType: string;
  contentHash: string;
  bytes: number;
  uri: string;
  access: "public" | "project" | "private";
  createdAt: string;
}

export interface JobReadModel { job: JobRecord; artifacts: JobArtifact[] }
export interface JobLog { id: string; jobId: string; attempt: number; sequence: number; stream: "stdout" | "stderr" | "progress" | "system"; message: string; data: unknown; createdAt: string }
export interface JobLogPage { jobId: string; logs: JobLog[]; nextSequence: number | null }

export class JobRuntime {
  constructor(
    private readonly client: CoreConnection,
    readonly workspaceId: string,
    readonly projectId: string,
  ) {}

  async submit(spec: Record<string, unknown>, confirmationToken: string | null): Promise<JobRecord> {
    const data = await this.execute<{ job: JobRecord }>("job.submit", { spec, confirmationToken });
    return data.job;
  }

  get(jobId: string): Promise<JobReadModel> {
    return this.query("job.get", { jobId });
  }

  logs(jobId: string, fromSequence = 1, limit = 200): Promise<JobLogPage> {
    return this.query("job.logs", { jobId, fromSequence: Math.max(1, fromSequence), limit: Math.min(500, Math.max(1, limit)) });
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const data = await this.execute<{ job: JobRecord }>("job.cancel", { jobId });
    return data.job;
  }

  async retry(jobId: string): Promise<JobRecord> {
    const data = await this.execute<{ job: JobRecord }>("job.retry", { jobId });
    return data.job;
  }

  stream(jobId: string, logFrom: number, signal: AbortSignal): AsyncGenerator<CoreStreamEvent> {
    return this.client.stream({ workspaceId: this.workspaceId, projectId: this.projectId, actorId: "user:research-explorer", jobId, logFrom, signal });
  }

  private async query<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const result = await this.client.query<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, queryId: `cli-${randomUUID()}`, type, workspaceId: this.workspaceId, projectId: this.projectId, actor: actor(), ...payload });
    if (result.status !== "ok" || result.data === null) throw operationError(result.error, `${type} query failed`);
    return result.data;
  }

  private async execute<T>(type: string, payload: unknown): Promise<T> {
    const id = randomUUID();
    const result = await this.client.execute<T>({ schemaVersion: PUBLIC_SCHEMA_VERSION, commandId: `cli-${id}`, idempotencyKey: `cli-${id}`, type, workspaceId: this.workspaceId, projectId: this.projectId, actor: actor(), issuedAt: new Date().toISOString(), payload });
    if (result.status !== "accepted" || result.data === null) throw operationError(result.error, `${type} command failed`);
    return result.data;
  }
}

function actor() { return { id: "user:research-explorer", kind: "user", displayName: "Research Explorer user" } as const; }
function operationError(error: { code: string; message: string } | null, fallback: string) { return new ResearchOperationError(error?.message ?? fallback, error?.code ?? "INTERNAL"); }

