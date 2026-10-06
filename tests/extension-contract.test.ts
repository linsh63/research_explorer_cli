import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResearchExplorerExtension, RESEARCH_EXPLORER_ENTRY } from "../src/extension/index.js";
import type { CoreConnection, DoctorReport, ProjectStatus } from "../src/core/types.js";
import { DIRECTION_FALLBACK_OPTIONS } from "../src/extension/direction-ui.js";
import type { ExecutionMode, ResearchAction } from "../src/research/types.js";
import { SecretInput } from "../src/extension/secret-input.js";

function projectStatus(overrides: Partial<ProjectStatus["project"]> = {}): ProjectStatus {
  return {
    schemaVersion: "1.0.0",
    workspaceId: "workspace:default",
    project: {
      id: "project-c2",
      title: "C2 Project",
      direction: "Investigate a concrete and falsifiable C2 research question.",
      domain: "AI/ML",
      profile: "exploratory",
      status: "draft",
      updatedAt: new Date().toISOString(),
      ...overrides,
    },
    questions: [],
    counts: { assumptions: 0, hypothesisSets: 0, protocols: 0, approvals: 0, deviations: 0, derivations: 0 },
    confirmationObserved: false,
    persistence: { branchName: "main", lastEventSequence: 1, eventCount: 1 },
  };
}

function action(type: ResearchAction["type"] = "question.propose"): ResearchAction {
  return {
    id: `action-${type}`,
    type,
    title: type === "scope.approve" ? "Approve scope" : "Propose question",
    description: "A bounded research transition",
    rationale: "The Project needs its next legal transition.",
    factRefs: [],
    assumptionRefs: [],
    expectedInformationGain: "high",
    estimatedCostUsd: 0,
    estimatedMinutes: 1,
    risks: ["May require revision"],
    stoppingConditions: ["Core rejects the transition"],
    requiredPermissions: [],
    requiresHumanApproval: type === "scope.approve",
    input: type === "question.propose" ? { question: {} } : type === "question.select" ? { questionId: "question-1" } : { note: "Approved by user" },
  };
}

function fakeClient(initialMode: ExecutionMode = "manual", candidateType: ResearchAction["type"] = "question.propose") {
  let mode = initialMode;
  const requests: any[] = [];
  const status = projectStatus();
  const candidateAction = action(candidateType);
  const job = { id: "job-c3", workspaceId: status.workspaceId, projectId: status.project.id, status: "succeeded", spec: {}, currentAttempt: 1, cancelRequested: false, failureClass: null, failureMessage: null, createdAt: "now", updatedAt: "now", startedAt: "now", finishedAt: "now" };
  const policy = () => ({ mode, maxAutoActionsPerTurn: mode === "auto" ? 1 : 0, maxKnownCostUsdPerAction: 0, autoAllowedActionTypes: ["question.propose", "question.select"], updatedAt: "now" });
  const client: CoreConnection = {
    baseUrl: "http://127.0.0.1:4321",
    capabilities: { serviceVersion: "1.0.0", schemaVersion: "1.0.0", endpoints: [], offline: true, startedAt: "now" },
    async health() { return { status: "ok", serviceVersion: "1.0.0", schemaVersion: "1.0.0", offline: true }; },
    async execute(input: any) {
      requests.push(input);
      if (input.type === "project.create") return { status: "accepted", projectId: status.project.id, data: { project: status.project }, error: null };
      if (input.type === "policy.set") {
        mode = input.payload.mode;
        return { status: "accepted", projectId: status.project.id, data: { policy: policy() }, error: null };
      }
      if (input.type === "conversation.send") {
        return { status: "accepted", projectId: status.project.id, data: { sessionId: "conversation-1", reply: "Choose next action", executedAction: null, actionResult: null, candidates: { id: "set-1", workspaceId: status.workspaceId, projectId: status.project.id, sessionId: "conversation-1", status: "open", candidates: [{ id: "candidate-1", kind: "action", title: candidateAction.title, description: candidateAction.description, action: candidateAction }, { id: "candidate-free", kind: "free_input", title: "Other", description: "Free input", action: null }], freeInputAllowed: true, createdAt: "now", consumedAt: null }, policy: policy() }, error: null };
      }
      if (input.type === "candidate.choose") return { status: "accepted", projectId: status.project.id, data: { sessionId: "conversation-1", reply: "Executed", executedAction: candidateAction, actionResult: {}, candidates: null, policy: policy() }, error: null };
      if (input.type === "action.execute") return { status: "accepted", projectId: status.project.id, data: { action: input.payload.action, result: {} }, error: null };
      if (input.type === "job.submit") return { status: "accepted", projectId: status.project.id, data: { job }, error: null };
      if (input.type === "job.cancel") return { status: "accepted", projectId: status.project.id, data: { job: { ...job, status: "cancelled" } }, error: null };
      if (input.type === "job.retry") return { status: "accepted", projectId: status.project.id, data: { job: { ...job, status: "queued", finishedAt: null } }, error: null };
      throw new Error(`Unexpected execute ${input.type}`);
    },
    async query(input: any) {
      requests.push(input);
      const data = input.type === "project.status" ? status
        : input.type === "workspace.projects" ? { schemaVersion: "1.0.0", workspaceId: status.workspaceId, projects: [{ ...status.project, branchName: "main", projectStatus: "active" }] }
        : input.type === "policy.get" ? policy()
          : input.type === "project.events" ? { events: [], nextSequence: null }
            : input.type === "conversation.get" ? { latestCandidates: { candidates: [{ id: "candidate-1", title: candidateAction.title, action: candidateAction }] } }
              : input.type === "job.get" ? { job, artifacts: [] }
                : input.type === "job.logs" ? { jobId: job.id, logs: [], nextSequence: null }
              : null;
      return { status: "ok", projectId: status.project.id, data, error: null };
    },
    async *stream() {},
  };
  return { client, requests, policy };
}

function savedContext(mode: ExecutionMode = "manual") {
  return { schemaVersion: 1, phase: "C2", workspaceId: "workspace:default", projectId: "project-c2", projectTitle: "Saved Project", projectStatus: "draft", mode, conversationSessionId: null, recordedAt: "earlier" };
}

function harness(options: { entries?: unknown[]; flags?: Record<string, boolean | string>; mode?: ExecutionMode; candidateType?: ResearchAction["type"]; connectError?: Error; selections?: string[]; confirmations?: boolean[]; extensionMode?: "tui" | "rpc" } = {}) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const renderers = new Map<string, any>();
  const registeredFlags = new Set<string>();
  const flags = new Map(Object.entries(options.flags ?? {}));
  const appended: Array<{ type: string; data: any }> = [];
  const sentMessages: string[] = [];
  const uiCalls: any[][] = [];
  const fake = fakeClient(options.mode, options.candidateType);
  const selections = [...(options.selections ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
  const doctor: DoctorReport = { status: "connected", serviceVersion: "1.0.0", schemaVersion: "1.0.0", baseUrl: fake.client.baseUrl, offline: true, platform: "linux/x64", autoStart: true, serviceEntry: "/core.js", error: null };
  const pi = {
    registerFlag: (name: string, value: { default?: boolean | string }) => { registeredFlags.add(name); if (!flags.has(name) && value.default !== undefined) flags.set(name, value.default); },
    getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, value: unknown) => commands.set(name, value),
    registerTool: (value: any) => tools.set(value.name, value),
    registerEntryRenderer: (name: string, value: unknown) => renderers.set(name, value),
    on: (name: string, value: unknown) => handlers.set(name, value),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    setSessionName: (name: string) => uiCalls.push(["session-name", name]),
    sendUserMessage: (content: string) => sentMessages.push(content),
  };
  createResearchExplorerExtension({ connect: async () => { if (options.connectError) throw options.connectError; return fake.client; }, diagnose: async () => doctor })(pi as any);
  const ctx = {
    mode: options.extensionMode ?? "tui",
    hasUI: (options.extensionMode ?? "tui") === "tui",
    cwd: directoryForTests(),
    sessionManager: { getBranch: () => options.entries ?? [] },
    model: { provider: "test", id: "direction-model" },
    modelRegistry: {
      complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ directions: [
        { title: "梳理证据", goal: "确认关键证据缺口", nextStep: "检索三类直接相关工作", rationale: "先界定现有证据边界" },
        { title: "形成假设", goal: "建立可证伪解释", nextStep: "写出目标与竞争假设", rationale: "为实验提供判别标准" },
        { title: "设计实验", goal: "确定最低成本验证", nextStep: "定义基线、指标和实验单位", rationale: "尽早暴露可行性风险" },
      ] }) }] }),
    },
    ui: {
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => null,
      select: async (title: string, values: string[]) => { uiCalls.push(["select", title, values]); return selections.shift(); },
      confirm: async (...args: unknown[]) => { uiCalls.push(["confirm", ...args]); return confirmations.shift() ?? false; },
      notify: (...args: unknown[]) => uiCalls.push(["notify", ...args]),
      setTitle: (...args: unknown[]) => uiCalls.push(["title", ...args]),
      setStatus: (...args: unknown[]) => uiCalls.push(["status", ...args]),
      setWidget: (...args: unknown[]) => uiCalls.push(["widget", ...args]),
    },
  };
  return { ...fake, commands, tools, handlers, renderers, registeredFlags, appended, sentMessages, uiCalls, ctx };
}

test("C5 registers Project, Job, SSH, plugin, capability commands and bounded tools", () => {
  const h = harness();
  for (const command of ["research-job-submit", "research-ssh-setup", "research-plugin-search", "research-plugin-install", "research-plugin-update", "research-fork", "research-bundle-export", "research-bundle-import", "research-dependencies", "research-mode"]) assert.ok(h.commands.has(command), command);
  for (const command of ["doctor", "project", "status", "mode", "next", "actions"]) assert.ok(h.commands.has(command), command);
  assert.deepEqual([...h.tools.keys()], ["research_context", "research_events", "research_converse", "research_choose_candidate", "research_execute_action", "research_job", "research_plugins", "research_capability"]);
  assert.ok(h.renderers.has(RESEARCH_EXPLORER_ENTRY));
  for (const event of ["session_start", "input", "before_agent_start", "turn_start", "turn_end", "session_shutdown"]) assert.ok(h.handlers.has(event), event);
});

test("research-new binds only the Pi session and does not write a global recent Project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-create-"));
  try {
    const stateFile = join(directory, "state.json");
    const h = harness({ flags: { "research-state-file": stateFile } });
    await h.handlers.get("session_start")({}, h.ctx);
    await h.commands.get("research-new").handler("C2 Project", h.ctx);
    assert.equal(existsSync(stateFile), false);
    const persisted = h.appended.filter((item) => item.type === RESEARCH_EXPLORER_ENTRY).at(-1)?.data;
    assert.equal(persisted.phase, "C4");
    assert.equal(persisted.mode, "manual");
    assert.doesNotMatch(JSON.stringify(persisted), /token|secret|password|bearer|authorization/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a fresh session offers the Core project archive and can remain unbound", async () => {
  const projectChoice = "C2 Project · 确定研究问题";
  const selected = harness({ selections: [projectChoice] });
  await selected.handlers.get("session_start")({}, selected.ctx);
  assert.ok(selected.requests.some((request) => request.type === "workspace.projects"));
  assert.equal(selected.appended.filter((item) => item.type === RESEARCH_EXPLORER_ENTRY).at(-1)?.data.projectTitle, "C2 Project");
  assert.ok(selected.uiCalls.some((call) => call[0] === "session-name" && call[1] === "C2 Project"));

  const free = harness({ selections: ["自由聊天（不绑定项目）"] });
  await free.handlers.get("session_start")({}, free.ctx);
  assert.ok(free.appended.some((item) => item.type === "research-explorer.unbound"));
  assert.ok(free.uiCalls.some((call) => call[0] === "widget" && call[2] === undefined));
  assert.ok(free.uiCalls.some((call) => call[0] === "status" && call[2] === undefined));
});

test("Job submission persists the public Job ID in the Pi session and excludes secret fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c3-job-"));
  try {
    const stateFile = join(directory, "state.json");
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext() }], flags: { "research-state-file": stateFile }, confirmations: [true] });
    await h.handlers.get("session_start")({}, h.ctx);
    const spec = { name: "test", dataRole: "exploration", studyId: null, execution: { kind: "bubblewrap", workspace: directory, command: "/bin/true", args: [], env: {}, artifactPaths: [] }, resources: { cpuCores: 1, memoryMiB: 128, diskMiB: 128, gpuCount: 0 }, limits: { wallTimeMs: 1000, cpuTimeSeconds: 1, maxOutputBytes: 1000, maxArtifactBytes: 1000 }, priority: 0, resumable: true, maxAttempts: 1, executionPhase: "general" };
    await h.commands.get("research-job-submit").handler(JSON.stringify(spec), h.ctx);
    assert.equal(existsSync(stateFile), false);
    const persisted = h.appended.filter((item) => item.type === RESEARCH_EXPLORER_ENTRY).at(-1)?.data;
    assert.deepEqual(persisted.jobIds, ["job-c3"]);
    assert.equal(persisted.activeJobId, "job-c3");
    assert.doesNotMatch(JSON.stringify(persisted), /confirmationToken|bearer|password/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("confirmation Job refuses non-TUI token input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c3-confirmation-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext() }], flags: { "research-state-file": join(directory, "state.json") }, confirmations: [true], extensionMode: "rpc" });
    await h.handlers.get("session_start")({}, h.ctx);
    const spec = { name: "confirm", dataRole: "confirmation", studyId: "study-1", execution: { kind: "bubblewrap" } };
    await h.commands.get("research-job-submit").handler(JSON.stringify(spec), h.ctx);
    assert.equal(h.requests.some((item) => item.type === "job.submit"), false);
    assert.ok(h.uiCalls.some((call) => call[0] === "notify" && String(call[1]).includes("interactive TUI")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("confirmation token component masks every typed character", () => {
  let submitted: string | null = null;
  const component = new SecretInput({ requestRender() {} } as any, { fg: (_color: string, text: string) => text } as any, (value) => { submitted = value; });
  component.handleInput("confirmation-value-1234567890");
  const rendered = component.render(80).join("\n");
  assert.doesNotMatch(rendered, /confirmation-value|1234567890/);
  assert.match(rendered, /••••/);
  component.handleInput("\r");
  assert.equal(submitted, "confirmation-value-1234567890");
  assert.doesNotMatch(component.render(80).join("\n"), /confirmation-value|1234567890/);
});

test("candidate mode lets Pi answer and then presents detailed research directions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-candidate-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext("candidate") }], mode: "candidate", flags: { "research-state-file": join(directory, "state.json") }, selections: [DIRECTION_FALLBACK_OPTIONS[0]] });
    await h.handlers.get("session_start")({}, h.ctx);
    const result = await h.handlers.get("input")({ text: "Help me continue", source: "interactive" }, h.ctx);
    assert.deepEqual(result, { action: "continue" });
    await h.handlers.get("turn_end")({ message: { role: "assistant", content: [{ type: "text", text: "先分析当前研究问题。" }] } }, h.ctx);
    const select = h.uiCalls.find((call) => call[0] === "select");
    for (const option of DIRECTION_FALLBACK_OPTIONS) assert.ok(select[2].includes(option));
    assert.ok(select[2].some((option: string) => option.includes("目标：") && option.includes("下一步：") && option.includes("理由：")));
    assert.equal(h.requests.filter((request) => request.type === "candidate.choose").length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("switching to candidate mode immediately opens detailed directions", async () => {
  const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext("manual") }], mode: "manual", selections: [DIRECTION_FALLBACK_OPTIONS[0]] });
  await h.handlers.get("session_start")({}, h.ctx);
  await h.commands.get("mode").handler("candidate", h.ctx);
  const select = h.uiCalls.find((call) => call[0] === "select" && call[1] === "选择下一步研究方向");
  assert.ok(select);
  assert.ok(select[2].some((option: string) => option.includes("目标：") && option.includes("下一步：")));
});

function directoryForTests(): string { return process.cwd(); }

test("manual mode preserves native Pi chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-manual-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext("manual") }], flags: { "research-state-file": join(directory, "state.json") } });
    await h.handlers.get("session_start")({}, h.ctx);
    assert.deepEqual(await h.handlers.get("input")({ text: "ordinary chat", source: "interactive" }, h.ctx), { action: "continue" });
    assert.equal(h.requests.some((request) => request.type === "conversation.send"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("model tool cannot execute mandatory scope approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-gate-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext() }], flags: { "research-state-file": join(directory, "state.json") }, confirmations: [true] });
    await h.handlers.get("session_start")({}, h.ctx);
    const result = await h.tools.get("research_execute_action").execute("call", { action: action("scope.approve") }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "GATE_REQUIRES_CANDIDATE");
    assert.equal(h.requests.some((request) => request.type === "action.execute"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("non-gate action tool requires confirmation and executes as the user", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-write-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext() }], flags: { "research-state-file": join(directory, "state.json") }, confirmations: [true] });
    await h.handlers.get("session_start")({}, h.ctx);
    const result = await h.tools.get("research_execute_action").execute("call", { action: action() }, undefined, undefined, h.ctx);
    assert.equal(result.isError, undefined);
    const request = h.requests.find((item) => item.type === "action.execute");
    assert.equal(request.actor.kind, "user");
    assert.ok(h.uiCalls.some((call) => call[0] === "confirm"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Core legal-action picker still requires explicit confirmation for scope approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-approval-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext("candidate") }], mode: "candidate", candidateType: "scope.approve", flags: { "research-state-file": join(directory, "state.json") }, selections: ["1. Approve scope [需要人工批准]"], confirmations: [false] });
    await h.handlers.get("session_start")({}, h.ctx);
    await h.commands.get("actions").handler("Approve", h.ctx);
    assert.equal(h.requests.some((item) => item.type === "candidate.choose"), false);
    assert.ok(h.uiCalls.some((call) => call[0] === "confirm" && call[1] === "批准科研范围？"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("offline restore remains unverified and redacts bearer values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c2-degraded-"));
  try {
    const h = harness({ entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: savedContext("auto") }], flags: { "research-state-file": join(directory, "state.json") }, connectError: new Error("Bearer abcdefghijklmnopqrstuvwxyz123456 is unavailable") });
    await h.handlers.get("session_start")({}, h.ctx);
    const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "base" }, h.ctx);
    assert.match(prompt.systemPrompt, /unverified Project binding/);
    assert.doesNotMatch(JSON.stringify(h.uiCalls), /abcdefghijklmnopqrstuvwxyz123456/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
