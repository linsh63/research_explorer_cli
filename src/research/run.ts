import { randomUUID } from "node:crypto";

export type ResearchRunStatus = "running" | "awaiting_approval" | "paused" | "blocked" | "completed" | "cancelled";
export type ResearchStageId = "scope" | "evidence" | "hypotheses" | "protocol" | "baseline" | "exploration" | "confirmation" | "analysis" | "review" | "report";
export type ResearchGate = "scope_approval" | "protocol_freeze" | "confirmation_unlock" | "final_decision";

export interface ResearchRunState {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  projectId: string;
  goal: string;
  status: ResearchRunStatus;
  stageIndex: number;
  stage: ResearchStageId;
  awaitingGate: ResearchGate | null;
  completedStages: ResearchStageId[];
  modelTurns: number;
  knownCostUsd: number;
  maxModelTurns: number;
  maxKnownCostUsd: number;
  blocker: string | null;
  startedAt: string;
  updatedAt: string;
}

export const RESEARCH_RUN_ENTRY = "research-explorer.run";
export const RESEARCH_STAGES: Array<{ id: ResearchStageId; title: string; gateAfter: ResearchGate | null }> = [
  { id: "scope", title: "问题与范围", gateAfter: "scope_approval" },
  { id: "evidence", title: "文献与证据", gateAfter: null },
  { id: "hypotheses", title: "竞争假设", gateAfter: null },
  { id: "protocol", title: "协议与实验设计", gateAfter: "protocol_freeze" },
  { id: "baseline", title: "基线复现", gateAfter: null },
  { id: "exploration", title: "有界探索", gateAfter: "confirmation_unlock" },
  { id: "confirmation", title: "确认实验", gateAfter: null },
  { id: "analysis", title: "统计分析与解释", gateAfter: null },
  { id: "review", title: "独立审查与回应", gateAfter: null },
  { id: "report", title: "报告与最终决策", gateAfter: "final_decision" },
];

export function createResearchRun(input: { sessionId: string; projectId: string; goal: string; maxModelTurns?: number; maxKnownCostUsd?: number }, now = new Date()): ResearchRunState {
  const timestamp = now.toISOString();
  return { schemaVersion: 1, runId: `run-${randomUUID()}`, sessionId: input.sessionId, projectId: input.projectId, goal: input.goal, status: "running", stageIndex: 0, stage: "scope", awaitingGate: null, completedStages: [], modelTurns: 0, knownCostUsd: 0, maxModelTurns: input.maxModelTurns ?? 20, maxKnownCostUsd: input.maxKnownCostUsd ?? 5, blocker: null, startedAt: timestamp, updatedAt: timestamp };
}

/**
 * Resume at the first stage that is not already guaranteed by Core's Project
 * lifecycle. Core lifecycle state is authoritative for gates; ResearchRun is
 * authoritative for the finer-grained work between those gates.
 */
export function alignRunToProjectStatus(state: ResearchRunState, projectStatus: string, now = new Date()): ResearchRunState {
  const stageByStatus: Record<string, ResearchStageId | "completed"> = {
    draft: "scope",
    scoped: "evidence",
    protocol_ready: "protocol",
    frozen: "baseline",
    confirmation_observed: "analysis",
    closed: "completed",
    derived: "evidence",
  };
  const target = stageByStatus[projectStatus] ?? "scope";
  if (target === "completed") {
    return { ...state, status: "completed", stageIndex: RESEARCH_STAGES.length - 1, stage: "report", awaitingGate: null, completedStages: RESEARCH_STAGES.map(item => item.id), blocker: null, updatedAt: now.toISOString() };
  }
  const stageIndex = RESEARCH_STAGES.findIndex(item => item.id === target);
  return {
    ...state,
    stageIndex,
    stage: target,
    completedStages: RESEARCH_STAGES.slice(0, stageIndex).map(item => item.id),
    updatedAt: now.toISOString(),
  };
}

export function restoreResearchRun(entries: readonly unknown[]): ResearchRunState | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== RESEARCH_RUN_ENTRY) continue;
    return parseRun(entry.data);
  }
  return null;
}

export function recordRunTurn(state: ResearchRunState, costUsd = 0, now = new Date()): ResearchRunState {
  const modelTurns = state.modelTurns + 1, knownCostUsd = state.knownCostUsd + Math.max(0, costUsd);
  if (modelTurns >= state.maxModelTurns || knownCostUsd >= state.maxKnownCostUsd) return { ...state, status: "blocked", modelTurns, knownCostUsd, blocker: modelTurns >= state.maxModelTurns ? "模型调用预算已耗尽" : "已知费用预算已耗尽", updatedAt: now.toISOString() };
  const descriptor = RESEARCH_STAGES[state.stageIndex]!;
  const completedStages = [...new Set([...state.completedStages, descriptor.id])];
  if (descriptor.gateAfter) return { ...state, status: "awaiting_approval", awaitingGate: descriptor.gateAfter, completedStages, modelTurns, knownCostUsd, blocker: null, updatedAt: now.toISOString() };
  const nextIndex = state.stageIndex + 1;
  if (nextIndex >= RESEARCH_STAGES.length) return { ...state, status: "completed", completedStages, modelTurns, knownCostUsd, updatedAt: now.toISOString() };
  return { ...state, status: "running", stageIndex: nextIndex, stage: RESEARCH_STAGES[nextIndex]!.id, awaitingGate: null, completedStages, modelTurns, knownCostUsd, blocker: null, updatedAt: now.toISOString() };
}

export function approveRunGate(state: ResearchRunState, now = new Date()): ResearchRunState {
  if (state.status !== "awaiting_approval" || !state.awaitingGate) return state;
  if (state.awaitingGate === "final_decision") return { ...state, status: "completed", awaitingGate: null, updatedAt: now.toISOString() };
  const nextIndex = state.stageIndex + 1;
  if (nextIndex >= RESEARCH_STAGES.length) return { ...state, status: "completed", awaitingGate: null, updatedAt: now.toISOString() };
  return { ...state, status: "running", stageIndex: nextIndex, stage: RESEARCH_STAGES[nextIndex]!.id, awaitingGate: null, blocker: null, updatedAt: now.toISOString() };
}

export function runPrompt(state: ResearchRunState): string {
  const stage = RESEARCH_STAGES[state.stageIndex]!;
  const instructions: Record<ResearchStageId, string> = {
    scope: "审查已选研究问题的可证伪性、对象、比较基线、主要指标、约束和停止条件。不要调用 conversation/候选接口寻找计划，也不要代替用户批准范围。",
    evidence: "开展文献与证据工作：列出检索式、证据来源、最接近工作、支持与反对证据及空白。可用时调用 literature-evidence 或检索工具；没有来源时明确需要检索，而不是编造引用。",
    hypotheses: "形成目标假设、零假设和至少一个竞争解释，给出可判别预测与更新规则。可用时调用 rival-hypotheses 能力验证完整性。",
    protocol: "形成可执行协议：实验单位、数据角色、基线、变量、控制、主要指标、统计方案、资源墙和停止条件。可用时调用 design-confounding 能力。不得自行冻结协议。",
    baseline: "检查运行环境并设计或执行最小基线复现。需要真实执行时提交 Job，记录命令、版本、日志和 Artifact；不要把计划当作结果。",
    exploration: "在冻结边界内进行有预算的候选探索，比较失败与成功尝试，保留谱系、成本和停止原因，不查看确认数据。",
    confirmation: "只在确认门禁已批准后执行冻结候选的一次确认评估，保持确认数据隔离并记录完整 Artifact。",
    analysis: "按实验单位进行统计分析，报告效应、缺失值、诊断、替代解释和适用范围。可用时调用 statistics-units 能力。",
    review: "分别从证据、方法、统计和可复现性进行审查，列出发现、严重度和必须回应的修改。",
    report: "基于 Core 事实和 Artifact 生成受约束报告，区分事实、推断与未验证主张。可用时调用 scientific-writing；不得宣称自动发布。",
  };
  return [
    `[自动科研任务 ${state.runId}]`,
    `研究目标：${state.goal}`,
    `当前阶段：${stage.title}（${state.stageIndex + 1}/${RESEARCH_STAGES.length}）`,
    instructions[state.stage],
    "ResearchRun 的阶段计划是下一步工作的唯一来源。Core conversation/legalActions 只用于早期问题动作和人工门禁；其返回“没有可自动推进的行动”不代表本任务没有下一步。",
    "请完成当前阶段可以安全完成的工作。优先调用 Research Explorer 的公共科研工具读取状态、检索证据或验证结果。",
    "不要虚构论文、实验、指标或完成状态。把产物、缺失条件、风险和建议的下一步明确写入回答。",
    "不得自行跨越人工门禁；如果当前阶段无法完成，明确指出缺失的环境、权限、数据、依赖或预算。",
  ].join("\n");
}

export function runSummary(state: ResearchRunState): string {
  const stage = RESEARCH_STAGES[state.stageIndex];
  return [`任务：${state.runId}`, `状态：${state.status}`, `阶段：${stage?.title ?? state.stage}（${state.stageIndex + 1}/${RESEARCH_STAGES.length}）`, `已完成：${state.completedStages.map(id => RESEARCH_STAGES.find(item => item.id === id)?.title ?? id).join("、") || "无"}`, `模型轮次：${state.modelTurns}/${state.maxModelTurns}`, `已知费用：$${state.knownCostUsd.toFixed(4)}/$${state.maxKnownCostUsd.toFixed(2)}`, state.awaitingGate ? `等待门禁：${gateLabel(state.awaitingGate)}` : null, state.blocker ? `阻塞：${state.blocker}` : null].filter(Boolean).join("\n");
}

export function gateLabel(gate: ResearchGate): string { return gate === "scope_approval" ? "研究范围批准" : gate === "protocol_freeze" ? "协议冻结" : gate === "confirmation_unlock" ? "确认实验解封" : "最终结论确认"; }

function parseRun(value: unknown): ResearchRunState | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ResearchRunState>;
  if (item.schemaVersion !== 1 || typeof item.runId !== "string" || typeof item.sessionId !== "string" || typeof item.projectId !== "string" || typeof item.goal !== "string" || typeof item.stageIndex !== "number" || typeof item.stage !== "string" || typeof item.status !== "string") return null;
  if (!RESEARCH_STAGES.some(stage => stage.id === item.stage) || !["running", "awaiting_approval", "paused", "blocked", "completed", "cancelled"].includes(item.status)) return null;
  return item as ResearchRunState;
}
