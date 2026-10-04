import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { safeError } from "../core/client.js";
import type { ResearchRuntime } from "../research/runtime.js";
import type { ConversationOutcome, ResearchAction } from "../research/types.js";

export interface ResearchToolHost {
  runtime(): ResearchRuntime | null;
  sessionId(): string | null;
  onOutcome(outcome: ConversationOutcome | null, ctx: ExtensionContext): Promise<void>;
}

export function registerResearchTools(pi: ExtensionAPI, host: ResearchToolHost): void {
  pi.registerTool({
    name: "research_context",
    label: "Research context",
    description: "Read the active Project status and execution policy from Core.",
    promptSnippet: "Read the verified Research Explorer Project context",
    promptGuidelines: ["Read research_context before proposing Project-specific work. Treat Core gates as authoritative."],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const runtime = host.runtime();
      if (!runtime) return failure("No verified Project is active.", "NO_PROJECT");
      try {
        const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
        return success({
          project: status.project,
          questions: status.questions.slice(0, 20),
          counts: status.counts,
          confirmationObserved: status.confirmationObserved,
          policy,
        }, { operation: "context" });
      } catch (error) {
        return failure(safeError(error), "CORE_ERROR");
      }
    },
  });

  pi.registerTool({
    name: "research_events",
    label: "Research events",
    description: "Read a bounded page of audited Project events from Core.",
    promptSnippet: "Read bounded audited research event metadata",
    parameters: Type.Object({
      fromSequence: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtime = host.runtime();
      if (!runtime) return failure("No verified Project is active.", "NO_PROJECT");
      try {
        const page = await runtime.events(params.fromSequence ?? 1, params.limit ?? 20);
        return success({
          events: page.events.map((event) => ({ eventId: event.eventId, type: event.type, sequence: event.sequence, occurredAt: event.occurredAt })),
          nextSequence: page.nextSequence,
        }, { operation: "events" });
      } catch (error) {
        return failure(safeError(error), "CORE_ERROR");
      }
    },
  });

  pi.registerTool({
    name: "research_converse",
    label: "Research conversation",
    description: "Ask Core for legal next ResearchAction candidates. In auto mode Core may execute one bounded action.",
    promptSnippet: "Request legal ResearchAction candidates from Core",
    parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtime = host.runtime();
      if (!runtime) return failure("No verified Project is active.", "NO_PROJECT");
      try {
        const outcome = await runtime.converse(params.message, host.sessionId(), "agent");
        await host.onOutcome(outcome, ctx);
        return success(summarizeOutcome(outcome), { operation: "converse" });
      } catch (error) {
        return failure(safeError(error), "CORE_ERROR");
      }
    },
  });

  pi.registerTool({
    name: "research_choose_candidate",
    label: "Choose research candidate",
    description: "Choose a Core-issued candidate after explicit user confirmation. Use freeInput for the candidate set's Other option.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1 }),
      candidateSetId: Type.String({ minLength: 1 }),
      candidateId: Type.Optional(Type.String({ minLength: 1 })),
      freeInput: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtime = host.runtime();
      if (!runtime) return failure("No verified Project is active.", "NO_PROJECT");
      if ((params.candidateId === undefined) === (params.freeInput === undefined)) {
        return failure("Provide exactly one of candidateId or freeInput.", "INVALID_INPUT");
      }
      try {
        const conversation = await runtime.conversation(params.sessionId) as { latestCandidates?: { candidates?: Array<{ id: string; title: string; action?: ResearchAction | null }> } };
        const candidate = conversation.latestCandidates?.candidates?.find((item) => item.id === params.candidateId);
        const approval = candidate?.action?.requiresHumanApproval || candidate?.action?.type === "scope.approve";
        const confirmed = await ctx.ui.confirm(
          approval ? "Approve mandatory research gate?" : "Execute ResearchAction?",
          approval
            ? `${candidate?.title ?? "Scope approval"}\n\nThis records explicit human scope approval in Core.`
            : params.freeInput ? `Send this alternative to Core?\n\n${params.freeInput}` : `${candidate?.title ?? params.candidateId}`,
        );
        if (!confirmed) return failure("User cancelled the candidate choice.", "USER_CANCELLED");
        const outcome = params.freeInput
          ? await runtime.chooseFreeInput({ sessionId: params.sessionId, candidateSetId: params.candidateSetId, freeInput: params.freeInput }, "user")
          : await runtime.chooseCandidate({ sessionId: params.sessionId, candidateSetId: params.candidateSetId, candidateId: params.candidateId! }, "user");
        await host.onOutcome(outcome, ctx);
        return success(summarizeOutcome(outcome), { operation: "choose_candidate" });
      } catch (error) {
        return failure(safeError(error), "CORE_ERROR");
      }
    },
  });

  pi.registerTool({
    name: "research_execute_action",
    label: "Execute ResearchAction",
    description: "Execute a structured non-gate ResearchAction after explicit user confirmation. Scope approval is refused here.",
    parameters: Type.Object({ action: Type.Unknown() }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtime = host.runtime();
      if (!runtime) return failure("No verified Project is active.", "NO_PROJECT");
      if (!isResearchAction(params.action)) return failure("A complete ResearchAction is required.", "INVALID_INPUT");
      if (params.action.type === "scope.approve" || params.action.requiresHumanApproval) {
        return failure("Mandatory gates must be approved through a Core-issued candidate and explicit candidate UI.", "GATE_REQUIRES_CANDIDATE");
      }
      const confirmed = await ctx.ui.confirm("Execute ResearchAction?", `${params.action.title}\n\n${params.action.description}`);
      if (!confirmed) return failure("User cancelled the ResearchAction.", "USER_CANCELLED");
      try {
        const result = await runtime.executeAction(params.action, "user");
        await host.onOutcome(null, ctx);
        return success(result, { operation: "execute_action", actionType: params.action.type });
      } catch (error) {
        return failure(safeError(error), "CORE_ERROR");
      }
    },
  });
}

function summarizeOutcome(outcome: ConversationOutcome) {
  return {
    sessionId: outcome.sessionId,
    reply: outcome.reply,
    executedAction: outcome.executedAction,
    candidates: outcome.candidates ? {
      id: outcome.candidates.id,
      freeInputAllowed: outcome.candidates.freeInputAllowed,
      candidates: outcome.candidates.candidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        description: candidate.description,
        action: candidate.action,
      })),
    } : null,
    policy: outcome.policy,
  };
}

function success(value: unknown, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: boundedJson(value) }], details };
}

function failure(message: string, code: string) {
  return { content: [{ type: "text" as const, text: message.slice(0, 2000) }], details: { code }, isError: true };
}

function boundedJson(value: unknown, limit = 12_000): string {
  const text = JSON.stringify(value, null, 2);
  return text.length <= limit ? text : `${text.slice(0, limit - 24)}\n… output truncated`;
}

function isResearchAction(value: unknown): value is ResearchAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<ResearchAction>;
  return typeof action.id === "string" && typeof action.title === "string" && typeof action.description === "string"
    && ["question.propose", "question.select", "scope.approve"].includes(action.type ?? "")
    && typeof action.requiresHumanApproval === "boolean" && !!action.input && typeof action.input === "object";
}
