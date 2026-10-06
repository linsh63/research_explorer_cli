import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { connectLocalCore, diagnoseCore, safeError } from "../core/client.js";
import { registerCoreFlags, resolveCoreConfig } from "../core/config.js";
import type { CoreConfig, CoreConnection, DoctorReport, ProjectStatus, WorkspaceProjects } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchRuntime } from "../research/runtime.js";
import type { ConversationOutcome, ExecutionMode } from "../research/types.js";
import { runCandidateInteraction } from "./candidate-ui.js";
import { assistantText, showResearchDirections } from "./direction-ui.js";
import { JobRuntime, type JobReadModel } from "../research/jobs.js";
import { SshRuntime } from "../research/ssh.js";
import { PluginRuntime } from "../research/plugins.js";
import { ProjectRuntime } from "../research/projects.js";
import { CapabilityRuntime } from "../research/capabilities.js";
import { registerJobFeatures } from "./job-commands.js";
import { JobMonitor, type MonitoredJob } from "./job-monitor.js";
import { registerSshCommands } from "./ssh-commands.js";
import { registerPluginFeatures } from "./plugin-commands.js";
import { registerProjectFeatures } from "./project-commands.js";
import { registerCapabilityFeatures } from "./capability-commands.js";
import {
  contextFromStatus,
  RESEARCH_EXPLORER_ENTRY,
  RESEARCH_EXPLORER_UNBOUND_ENTRY,
  restoreContext,
  type ResearchContextEntry,
} from "./state.js";
import { registerResearchTools } from "./tools.js";

export { RESEARCH_EXPLORER_ENTRY, type ResearchContextEntry } from "./state.js";

export interface ExtensionDependencies {
  connect(config: CoreConfig): Promise<CoreConnection>;
  diagnose(config: CoreConfig): Promise<DoctorReport>;
}

const defaultDependencies: ExtensionDependencies = {
  connect: connectLocalCore,
  diagnose: diagnoseCore,
};

export function createResearchExplorerExtension(overrides: Partial<ExtensionDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return function researchExplorerExtension(pi: ExtensionAPI): void {
    registerCoreFlags(pi);
    let config: CoreConfig;
    let client: CoreConnection | null = null;
    let context: ResearchContextEntry | null = null;
    let contextVerified = false;
    let connectionError: string | null = null;
    let snapshot: ProjectStatus | null = null;
    let sessionContext: ExtensionContext | null = null;
    let monitoredJobs: MonitoredJob[] = [];
    const jobMonitor = new JobMonitor((jobs) => {
      monitoredJobs = jobs;
      if (sessionContext) updateJobUi(sessionContext);
    });

    registerResearchTools(pi, {
      runtime: activeRuntime,
      sessionId: () => context?.conversationSessionId ?? null,
      onOutcome: applyOutcome,
    });
    registerJobFeatures(pi, {
      runtime: requireJobRuntime,
      activeJobId: () => context?.activeJobId ?? null,
      track: trackJob,
      refresh: refreshJob,
    });
    registerSshCommands(pi, { runtime: requireSshRuntime });
    registerPluginFeatures(pi, { runtime: requirePluginRuntime });
    registerProjectFeatures(pi, { runtime: requireProjectRuntime, open: openProject });
    registerCapabilityFeatures(pi, { runtime: requireCapabilityRuntime, status: currentStatus });

    pi.registerEntryRenderer<ResearchContextEntry>(RESEARCH_EXPLORER_ENTRY, (entry, { expanded }, theme) => {
      const data = entry.data;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      if (!data) {
        box.addChild(new Text(theme.fg("warning", "[Research Explorer] Invalid Project context"), 0, 0));
        return box;
      }
      box.addChild(new Text(`${theme.fg("accent", "[科研项目]")} ${data.projectTitle}${data.mode === "manual" ? "" : ` · ${stageLabel(data.projectStatus)} · ${modeLabel(data.mode)}`}`, 0, 0));
      if (expanded) {
        box.addChild(new Text(theme.fg("dim", `${data.workspaceId} · ${data.projectId} · ${data.recordedAt}`), 0, 0));
      }
      return box;
    });

    pi.registerCommand("research-about", {
      description: "Show Research Explorer connection and Project context",
      handler: async (_args, ctx) => {
        updateUi(ctx);
        ctx.ui.notify(context ? `${context.projectTitle} · ${stageLabel(context.projectStatus)} · ${modeLabel(context.mode)}` : "自由聊天 · 未绑定科研项目", "info");
      },
    });

    pi.registerCommand("research-doctor", {
      description: "Check Core discovery, authentication and version compatibility",
      handler: doctorCommand,
    });

    pi.registerCommand("research-new", {
      description: "Create and bind a new research Project: /research-new <title>",
      handler: createProjectCommand,
    });

    pi.registerCommand("research-open", {
      description: "Open a Project by ID: /research-open <project-id>",
      handler: openProjectCommand,
    });

    pi.registerCommand("research-status", {
      description: "Refresh and show the active research Project",
      handler: statusCommand,
    });

    pi.registerCommand("research-mode", {
      description: "Set research interaction mode: /research-mode manual|candidate|auto",
      handler: modeCommand,
    });

    pi.registerCommand("research-next", {
      description: "Generate detailed candidate research directions",
      handler: directionCommand,
    });

    pi.registerCommand("doctor", { description: "检查 Research Explorer 连接", handler: doctorCommand });
    pi.registerCommand("project", { description: "选择或新建科研项目", handler: projectCommand });
    pi.registerCommand("status", { description: "查看当前科研项目状态", handler: statusCommand });
    pi.registerCommand("mode", { description: "切换 manual、candidate 或 auto 模式", handler: modeCommand });
    pi.registerCommand("next", { description: "生成详细的下一步研究候选", handler: directionCommand });
    pi.registerCommand("actions", { description: "查看 Core 当前允许的流程动作", handler: legalActionsCommand });

    async function doctorCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      const report = await dependencies.diagnose(config);
      if (report.status === "connected") {
        client = await dependencies.connect(config);
        connectionError = null;
        if (context) {
          try {
            const runtime = new ResearchRuntime(client, context.workspaceId, context.projectId);
            const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
            snapshot = status;
            context = contextFromStatus(status, policy.mode, context.conversationSessionId, context.jobIds, context.activeJobId);
            contextVerified = true;
          } catch (error) {
            connectionError = safeError(error);
            client = null;
            contextVerified = false;
          }
        }
      } else {
        client = null;
        connectionError = report.error;
      }
      updateUi(ctx);
      ctx.ui.notify(client ? formatDoctor(report) : `Core unavailable · ${connectionError ?? report.error ?? "unknown error"}`, client ? "info" : "error");
    }

    async function createProjectCommand(args: string, ctx: ExtensionContext): Promise<void> {
      const title = args.trim() || (await ctx.ui.input("科研项目名称", "至少 3 个字符"))?.trim() || "";
      if (title.length < 3) return ctx.ui.notify("项目名称至少需要 3 个字符。", "warning");
      const activeClient = await requireClient(ctx);
      if (!activeClient) return;
      let result;
      try {
        result = await activeClient.execute<{ project?: unknown }>({
          schemaVersion: PUBLIC_SCHEMA_VERSION, commandId: `cli-${randomUUID()}`, idempotencyKey: `cli-project-${randomUUID()}`,
          workspaceId: config.workspaceId, projectId: null, actor: actor(), issuedAt: new Date().toISOString(), type: "project.create",
          payload: { intent: { title, direction: `Investigate ${title} through a concrete, falsifiable research question and a reproducible evaluation.`, domain: "AI/ML", constraints: [], allowedData: [], prohibitions: [], profile: "exploratory", budget: { gpuHours: 1, wallHours: 2, diskGiB: 2, modelCalls: 5, knownCostUsd: 0 } } },
        });
      } catch (error) {
        connectionError = safeError(error); client = null; updateUi(ctx); return ctx.ui.notify(`创建项目失败：${connectionError}`, "error");
      }
      if (result.status !== "accepted" || !result.projectId) return ctx.ui.notify(result.error?.message ?? "Core 拒绝创建项目。", "error");
      const status = await queryProject(activeClient, config.workspaceId, result.projectId);
      if (!status) return ctx.ui.notify("项目已创建，但无法读取项目状态。", "error");
      bind(status, ctx, "manual", null, [], null);
      pi.setSessionName(status.project.title);
      ctx.ui.notify(`已创建并打开：${status.project.title}`, "info");
    }

    async function openProjectCommand(args: string, ctx: ExtensionContext): Promise<void> {
      const projectId = args.trim();
      if (!projectId) return chooseProject(ctx);
      await openProject(projectId, ctx);
      if (context) pi.setSessionName(context.projectTitle);
    }

    async function projectCommand(_args: string, ctx: ExtensionContext): Promise<void> { await chooseProject(ctx); }

    async function statusCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      if (!context) return ctx.ui.notify("当前是自由聊天，尚未绑定科研项目。使用 /project 选择或新建项目。", "info");
      const current = context, activeClient = await requireClient(ctx);
      if (!activeClient) return;
      try {
        const [status, policy] = await Promise.all([queryProject(activeClient, current.workspaceId, current.projectId), new ResearchRuntime(activeClient, current.workspaceId, current.projectId).policy()]);
        if (!status) return ctx.ui.notify("当前项目不可用。", "error");
        bind(status, ctx, policy.mode, current.conversationSessionId);
        ctx.ui.notify(formatStatus(status), "info");
      } catch (error) {
        connectionError = safeError(error); client = null; contextVerified = false; updateUi(ctx); ctx.ui.notify(`Core unavailable: ${connectionError}`, "error");
      }
    }

    async function modeCommand(args: string, ctx: ExtensionContext): Promise<void> {
      let mode = parseMode(args);
      if (!mode) mode = parseMode((await ctx.ui.select("交互模式", ["manual · 自由聊天", "candidate · 候选方向", "auto · 有限自动"]))?.split(" ")[0] ?? "");
      if (!mode) return;
      const runtime = await requireRuntime(ctx);
      if (!runtime) return;
      if (mode === "auto" && !(await ctx.ui.confirm("开启有限自动模式？", "Core 每轮最多自动执行一个零成本、无额外权限的动作；人工门禁仍会暂停。"))) return;
      try {
        const policy = await runtime.setMode(mode);
        if (context) { context = { ...context, mode: policy.mode, recordedAt: new Date().toISOString() }; persistContext(ctx); }
        ctx.ui.notify(policy.mode === "candidate" ? "已切换为候选模式；每次回答后会额外调用当前模型生成研究方向。" : `已切换为${modeLabel(policy.mode)}。`, "info");
        if (policy.mode === "candidate" && snapshot) await showResearchDirections({ pi, ctx, status: snapshot, basis: "用户刚进入候选模式，请给出适合当前项目阶段的下一步方向。" });
      } catch (error) { ctx.ui.notify(`模式切换失败：${safeError(error)}`, "error"); }
    }

    async function directionCommand(args: string, ctx: ExtensionContext): Promise<void> {
      if (!context || !snapshot) return ctx.ui.notify("请先使用 /project 选择科研项目。", "warning");
      await showResearchDirections({ pi, ctx, status: snapshot, basis: args.trim() || "请根据当前项目阶段给出下一步研究方向。" });
    }

    async function legalActionsCommand(args: string, ctx: ExtensionContext): Promise<void> {
      const runtime = await requireRuntime(ctx);
      if (!runtime) return;
      await runCandidateInteraction({ runtime, message: args.trim() || "给出当前项目的下一步合法流程动作。", sessionId: context?.conversationSessionId ?? null, ctx, onOutcome: (outcome) => applyOutcome(outcome, ctx) });
    }

    async function chooseProject(ctx: ExtensionContext): Promise<void> {
      const activeClient = await requireClient(ctx);
      if (!activeClient) return;
      let data: WorkspaceProjects;
      try { data = await queryProjects(activeClient, config.workspaceId); }
      catch (error) { return ctx.ui.notify(`读取项目列表失败：${safeError(error)}`, "error"); }
      const labels = data.projects.map((item) => `${item.title} · ${stageLabel(item.status)}${item.branchName === "main" ? "" : ` · ${item.branchName}`}`);
      const free = "自由聊天（不绑定项目）", create = "新建科研项目";
      const selected = await ctx.ui.select("选择科研项目", [create, ...labels, free]);
      if (!selected) return;
      if (selected === free) { unbind(ctx); return; }
      if (selected === create) return createProjectCommand("", ctx);
      const index = labels.indexOf(selected), project = index >= 0 ? data.projects[index] : undefined;
      if (!project) return;
      await openProject(project.id, ctx);
      if (context) pi.setSessionName(context.projectTitle);
    }

    pi.on("session_start", async (_event, ctx) => {
      sessionContext = ctx;
      config = resolveCoreConfig(pi);
      context = restoreContext(ctx.sessionManager.getBranch());
      contextVerified = false;
      try {
        client = await dependencies.connect(config);
        connectionError = null;
        if (context) {
          const runtime = new ResearchRuntime(client, context.workspaceId, context.projectId);
          const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
          if (status) {
            snapshot = status;
            context = contextFromStatus(status, policy.mode, context.conversationSessionId, context.jobIds, context.activeJobId);
            contextVerified = true;
          }
          else context = null;
        }
      } catch (error) {
        client = null;
        connectionError = safeError(error);
      }
      if (client && context && contextVerified) {
        await jobMonitor.restore(new JobRuntime(client, context.workspaceId, context.projectId), context.jobIds);
      }
      updateUi(ctx);
      if (client && !context && ctx.mode === "tui" && ctx.hasUI) await chooseProject(ctx);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension" || event.streamingBehavior || context?.mode !== "auto" || !context) {
        return { action: "continue" as const };
      }
      const runtime = await requireRuntime(ctx);
      if (!runtime) return { action: "continue" as const };
      const result = await runCandidateInteraction({
        runtime,
        message: event.text,
        sessionId: context.conversationSessionId,
        ctx,
        onOutcome: (outcome) => applyOutcome(outcome, ctx),
      });
      return result === "handled" ? { action: "handled" as const } : { action: "continue" as const };
    });

    pi.on("before_agent_start", async (event) => {
      if (context && contextVerified) {
        try {
          snapshot = await activeRuntime()?.status() ?? snapshot;
        } catch {
          contextVerified = false;
        }
      }
      const researchContext = context && contextVerified
        ? `Research Explorer C5 Project snapshot: title=${context.projectTitle}; id=${context.projectId}; workspace=${context.workspaceId}; status=${snapshot?.project.status ?? context.projectStatus}; mode=${context.mode}; questions=${snapshot?.questions.length ?? 0}; events=${snapshot?.persistence.eventCount ?? 0}; trackedJobs=${context.jobIds.length}; activeJob=${context.activeJobId ?? "none"}. Use research tools for current Core state. All mutations must use public Core paths. Never claim a gate, Job, plugin, capability, report or dependency succeeded unless Core confirms it.`
        : context
          ? `Research Explorer C5 restored an unverified Project binding for ${context.projectId}, but current Core state is unavailable. Do not rely on its saved title, status or Job state and do not claim that research state was read or changed.`
          : `Research Explorer C5 has no active Project${connectionError ? " and Core is unavailable" : ""}. Do not claim that research state was read or changed.`;
      return { systemPrompt: `${event.systemPrompt}\n\n${researchContext}` };
    });

    pi.on("turn_start", async (_event, ctx) => {
      if (context?.mode !== "manual") ctx.ui.setStatus("research-explorer", "正在处理…");
    });
    pi.on("turn_end", async (event, ctx) => {
      updateUi(ctx);
      if (context?.mode === "candidate" && snapshot && ctx.mode === "tui" && ctx.hasUI) {
        const text = assistantText(event.message);
        if (text) await showResearchDirections({ pi, ctx, status: snapshot, basis: text });
      }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      jobMonitor.shutdown();
      sessionContext = null;
      ctx.ui.setStatus("research-explorer", undefined);
      ctx.ui.setWidget("research-explorer", undefined);
      ctx.ui.setStatus("research-jobs", undefined);
      ctx.ui.setWidget("research-jobs", undefined);
    });

    async function requireClient(ctx: ExtensionContext): Promise<CoreConnection | null> {
      if (client) return client;
      try {
        client = await dependencies.connect(config);
        connectionError = null;
        updateUi(ctx);
        return client;
      } catch (error) {
        connectionError = safeError(error);
        updateUi(ctx);
        ctx.ui.notify(`Core unavailable: ${connectionError}`, "error");
        return null;
      }
    }

    function activeRuntime(): ResearchRuntime | null {
      return client && context && contextVerified ? new ResearchRuntime(client, context.workspaceId, context.projectId) : null;
    }

    async function requireRuntime(ctx: ExtensionContext): Promise<ResearchRuntime | null> {
      if (!context) {
        ctx.ui.notify("No Project is selected. Use /research-new or /research-open <project-id>.", "warning");
        return null;
      }
      const activeClient = await requireClient(ctx);
      if (!activeClient) return null;
      const runtime = new ResearchRuntime(activeClient, context.workspaceId, context.projectId);
      if (!contextVerified) {
        try {
          const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
          snapshot = status;
          context = contextFromStatus(status, policy.mode, context.conversationSessionId, context.jobIds, context.activeJobId);
          contextVerified = true;
          persistContext(ctx);
        } catch (error) {
          ctx.ui.notify(`Project refresh failed: ${safeError(error)}`, "error");
          return null;
        }
      }
      return runtime;
    }

    async function requireJobRuntime(ctx: ExtensionContext): Promise<JobRuntime | null> {
      const runtime = await requireRuntime(ctx);
      return runtime && client && context ? new JobRuntime(client, context.workspaceId, context.projectId) : null;
    }

    async function requireSshRuntime(ctx: ExtensionContext): Promise<SshRuntime | null> {
      const runtime = await requireRuntime(ctx);
      return runtime && client && context ? new SshRuntime(client, context.workspaceId, context.projectId) : null;
    }

    async function requirePluginRuntime(ctx: ExtensionContext): Promise<PluginRuntime | null> {
      const runtime = await requireRuntime(ctx);
      return runtime && client && context ? new PluginRuntime(client, context.workspaceId, context.projectId) : null;
    }

    async function requireProjectRuntime(ctx: ExtensionContext): Promise<ProjectRuntime | null> {
      const runtime = await requireRuntime(ctx);
      return runtime && client && context ? new ProjectRuntime(client, context.workspaceId, context.projectId) : null;
    }

    async function requireCapabilityRuntime(ctx: ExtensionContext): Promise<CapabilityRuntime | null> {
      const runtime = await requireRuntime(ctx);
      return runtime && client && context ? new CapabilityRuntime(client, context.workspaceId, context.projectId) : null;
    }

    async function currentStatus(ctx: ExtensionContext): Promise<ProjectStatus | null> {
      const runtime = await requireRuntime(ctx);
      if (!runtime) return null;
      try { return await runtime.status(); }
      catch (error) { ctx.ui.notify(`Project status failed: ${safeError(error)}`, "error"); return null; }
    }

    async function openProject(projectId: string, ctx: ExtensionContext): Promise<void> {
      const activeClient = await requireClient(ctx);
      if (!activeClient) return;
      const [status, policy] = await Promise.all([
        queryProject(activeClient, config.workspaceId, projectId),
        new ResearchRuntime(activeClient, config.workspaceId, projectId).policy(),
      ]);
      if (!status) throw new Error(`Project ${projectId} is unavailable in ${config.workspaceId}`);
      bind(status, ctx, policy.mode, null, [], null);
    }

    async function trackJob(jobId: string, ctx: ExtensionContext): Promise<void> {
      const runtime = await requireJobRuntime(ctx);
      if (!runtime || !context) return;
      context = { ...context, jobIds: [...new Set([...context.jobIds, jobId])].slice(-100), activeJobId: jobId, recordedAt: new Date().toISOString() };
      persistContext(ctx);
      await jobMonitor.track(runtime, jobId);
    }

    async function refreshJob(jobId: string, ctx: ExtensionContext): Promise<JobReadModel | null> {
      const runtime = await requireJobRuntime(ctx);
      if (!runtime) return null;
      try {
        const state = await jobMonitor.refresh(runtime, jobId);
        if (context && !context.jobIds.includes(jobId)) {
          context = { ...context, jobIds: [...context.jobIds, jobId].slice(-100), activeJobId: jobId, recordedAt: new Date().toISOString() };
          persistContext(ctx);
        }
        return { job: state.job, artifacts: state.artifacts };
      } catch (error) {
        ctx.ui.notify(`Job refresh failed: ${safeError(error)}`, "error");
        return null;
      }
    }

    async function applyOutcome(outcome: ConversationOutcome | null, ctx: ExtensionContext): Promise<void> {
      const runtime = activeRuntime();
      if (!runtime || !context) return;
      const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
      snapshot = status;
      context = contextFromStatus(status, outcome?.policy.mode ?? policy.mode, outcome?.sessionId ?? context.conversationSessionId, context.jobIds, context.activeJobId);
      contextVerified = true;
      persistContext(ctx);
    }

    function bind(status: ProjectStatus, ctx: ExtensionContext, mode: ExecutionMode = "manual", sessionId: string | null = null, jobIds: string[] = context?.jobIds ?? [], activeJobId: string | null = context?.activeJobId ?? null): void {
      if (context && context.projectId !== status.project.id) jobMonitor.reset();
      snapshot = status;
      context = contextFromStatus(status, mode, sessionId, jobIds, activeJobId);
      contextVerified = true;
      persistContext(ctx);
    }

    function persistContext(ctx: ExtensionContext): void {
      if (!context) return;
      pi.appendEntry(RESEARCH_EXPLORER_ENTRY, context);
      updateUi(ctx);
    }

    function unbind(ctx: ExtensionContext): void {
      context = null;
      snapshot = null;
      contextVerified = false;
      jobMonitor.reset();
      pi.appendEntry(RESEARCH_EXPLORER_UNBOUND_ENTRY, { recordedAt: new Date().toISOString() });
      updateUi(ctx);
      ctx.ui.notify("已进入自由聊天；当前会话不会自动绑定科研项目。", "info");
    }

    function updateUi(ctx: ExtensionContext): void {
      const connected = client !== null;
      ctx.ui.setTitle(context && context.mode !== "manual" ? `Research Explorer · ${context.projectTitle}` : "Research Explorer");
      if (!context || context.mode === "manual") {
        ctx.ui.setStatus("research-explorer", undefined);
        ctx.ui.setWidget("research-explorer", undefined);
        updateJobUi(ctx);
        return;
      }
      ctx.ui.setStatus("research-explorer", contextVerified ? `${modeLabel(context.mode)} · ${stageLabel(context.projectStatus)}` : "项目状态待验证");
      ctx.ui.setWidget("research-explorer", [contextVerified ? context.projectTitle : "项目状态待验证", contextVerified ? `${stageLabel(context.projectStatus)} · ${modeLabel(context.mode)}` : connected ? "正在重新连接项目" : "Core 不可用"]);
      updateJobUi(ctx);
    }

    function updateJobUi(ctx: ExtensionContext): void {
      if (!monitoredJobs.length) {
        ctx.ui.setStatus("research-jobs", undefined);
        ctx.ui.setWidget("research-jobs", undefined);
        return;
      }
      const active = context?.activeJobId ? monitoredJobs.find((item) => item.job.id === context?.activeJobId) : monitoredJobs[0];
      const running = monitoredJobs.filter((item) => item.job.status === "queued" || item.job.status === "running").length;
      ctx.ui.setStatus("research-jobs", `${running} active Job${running === 1 ? "" : "s"}`);
      ctx.ui.setWidget("research-jobs", [
        `Jobs · ${monitoredJobs.length} tracked · ${running} active`,
        ...(active ? [`${active.job.id} · ${active.job.status} · ${active.connection}`, active.lastLog ? truncate(active.lastLog, 120) : `${active.artifacts.length} Artifact(s)`] : []),
      ], { placement: "belowEditor" });
    }
  };
}

export default createResearchExplorerExtension();

async function queryProject(client: CoreConnection, workspaceId: string, projectId: string): Promise<ProjectStatus | null> {
  const result = await client.query<ProjectStatus>({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    queryId: `cli-${randomUUID()}`,
    type: "project.status",
    workspaceId,
    projectId,
    actor: actor(),
  });
  return result.status === "ok" && result.data ? result.data : null;
}

async function queryProjects(client: CoreConnection, workspaceId: string): Promise<WorkspaceProjects> {
  const result = await client.query<WorkspaceProjects>({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    queryId: `cli-${randomUUID()}`,
    type: "workspace.projects",
    workspaceId,
    projectId: null,
    actor: actor(),
    limit: 100,
  });
  if (result.status !== "ok" || !result.data) throw new Error(result.error?.message ?? "workspace.projects query failed");
  return result.data;
}

function actor() {
  return { id: "user:research-explorer", kind: "user", displayName: "Research Explorer user" } as const;
}

function formatDoctor(report: DoctorReport): string {
  if (report.status === "disconnected") return `Core disconnected · ${report.error ?? "unknown error"}`;
  return `Core connected · service ${report.serviceVersion} · schema ${report.schemaVersion} · ${report.platform ?? "platform unknown"} · ${report.offline ? "offline" : "network enabled"}`;
}

function formatStatus(status: ProjectStatus): string {
  return `${status.project.title} · ${stageLabel(status.project.status)} · ${status.questions.length} 个研究问题`;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function parseMode(value: string): ExecutionMode | null {
  const mode = value.trim().toLowerCase();
  return mode === "manual" || mode === "candidate" || mode === "auto" ? mode : null;
}

function modeLabel(mode: ExecutionMode): string {
  return mode === "candidate" ? "候选模式" : mode === "auto" ? "有限自动" : "自由聊天";
}

function stageLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: "确定研究问题",
    scoped: "范围已确定",
    protocol_ready: "协议待冻结",
    frozen: "执行与分析",
    confirmation_observed: "确认结果已观察",
    closed: "研究已结束",
    derived: "派生研究",
  };
  return labels[status] ?? "阶段未知";
}
