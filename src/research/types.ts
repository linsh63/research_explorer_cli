export type ExecutionMode = "manual" | "candidate" | "auto";

export interface ExecutionPolicy {
  mode: ExecutionMode;
  maxAutoActionsPerTurn: number;
  maxKnownCostUsdPerAction: number;
  autoAllowedActionTypes: Array<"question.propose" | "question.select">;
  updatedAt: string;
}

export interface ResearchAction {
  id: string;
  type: "question.propose" | "question.select" | "scope.approve";
  title: string;
  description: string;
  rationale: string;
  factRefs: string[];
  assumptionRefs: string[];
  expectedInformationGain: "low" | "medium" | "high";
  estimatedCostUsd: number;
  estimatedMinutes: number;
  risks: string[];
  stoppingConditions: string[];
  requiredPermissions: string[];
  requiresHumanApproval: boolean;
  input: Record<string, unknown>;
}

export interface ResearchCandidate {
  id: string;
  kind: "action" | "free_input";
  title: string;
  description: string;
  action: ResearchAction | null;
}

export interface CandidateSet {
  id: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  status: "open" | "consumed" | "superseded";
  candidates: ResearchCandidate[];
  freeInputAllowed: true;
  createdAt: string;
  consumedAt: string | null;
}

export interface ConversationOutcome {
  sessionId: string;
  reply: string;
  executedAction: ResearchAction | null;
  actionResult: unknown;
  candidates: CandidateSet | null;
  policy: ExecutionPolicy;
}

export interface ResearchEvent {
  eventId: string;
  type: string;
  sequence: number;
  occurredAt: string;
  payload?: unknown;
}

