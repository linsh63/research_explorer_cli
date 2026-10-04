import { randomUUID } from "node:crypto";
import type { CoreConnection, ProjectStatus } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import type { CandidateSet, ConversationOutcome, ExecutionMode, ExecutionPolicy, ResearchAction, ResearchEvent } from "./types.js";

export class ResearchOperationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ResearchOperationError";
  }
}

export class ResearchRuntime {
  constructor(
    private readonly client: CoreConnection,
    readonly workspaceId: string,
    readonly projectId: string,
  ) {}

  async status(): Promise<ProjectStatus> {
    return this.query<ProjectStatus>("project.status", {});
  }

  async policy(): Promise<ExecutionPolicy> {
    return this.query<ExecutionPolicy>("policy.get", {});
  }

  async events(fromSequence = 1, limit = 20): Promise<{ events: ResearchEvent[]; nextSequence: number | null }> {
    return this.query("project.events", { fromSequence: Math.max(1, fromSequence), limit: Math.min(50, Math.max(1, limit)) });
  }

  async setMode(mode: ExecutionMode): Promise<ExecutionPolicy> {
    const result = await this.execute<{ policy: ExecutionPolicy }>("policy.set", {
      mode,
      maxAutoActionsPerTurn: mode === "auto" ? 1 : 0,
      maxKnownCostUsdPerAction: 0,
      autoAllowedActionTypes: ["question.propose", "question.select"],
    }, "user");
    return result.policy;
  }

  converse(message: string, sessionId: string | null, actorKind: "user" | "agent"): Promise<ConversationOutcome> {
    return this.execute("conversation.send", { sessionId, message }, actorKind);
  }

  chooseCandidate(input: { sessionId: string; candidateSetId: string; candidateId: string }, actorKind: "user" | "agent" = "user"): Promise<ConversationOutcome> {
    return this.execute("candidate.choose", { ...input, freeInput: null }, actorKind);
  }

  chooseFreeInput(input: { sessionId: string; candidateSetId: string; freeInput: string }, actorKind: "user" | "agent" = "user"): Promise<ConversationOutcome> {
    return this.execute("candidate.choose", { ...input, candidateId: null }, actorKind);
  }

  executeAction(action: ResearchAction, actorKind: "user" | "agent"): Promise<{ action: ResearchAction; result: unknown }> {
    return this.execute("action.execute", { action }, actorKind);
  }

  async conversation(sessionId: string): Promise<unknown> {
    return this.query("conversation.get", { sessionId });
  }

  private async query<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const result = await this.client.query<T>({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      queryId: `cli-${randomUUID()}`,
      type,
      workspaceId: this.workspaceId,
      projectId: this.projectId,
      actor: actor("user"),
      ...payload,
    });
    if (result.status !== "ok" || result.data === null) throw operationError(result.error, `${type} query failed`);
    return result.data;
  }

  private async execute<T>(type: string, payload: unknown, actorKind: "user" | "agent"): Promise<T> {
    const result = await this.client.execute<T>({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      commandId: `cli-${randomUUID()}`,
      idempotencyKey: `cli-${randomUUID()}`,
      workspaceId: this.workspaceId,
      projectId: this.projectId,
      actor: actor(actorKind),
      issuedAt: new Date().toISOString(),
      type,
      payload,
    });
    if (result.status !== "accepted" || result.data === null) throw operationError(result.error, `${type} command failed`);
    return result.data;
  }
}

function actor(kind: "user" | "agent") {
  return kind === "user"
    ? { id: "user:research-explorer", kind, displayName: "Research Explorer user" }
    : { id: "agent:research-explorer", kind, displayName: "Research Explorer agent" };
}

function operationError(error: { code: string; message: string } | null, fallback: string): ResearchOperationError {
  return new ResearchOperationError(error?.message ?? fallback, error?.code ?? "INTERNAL");
}
