import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { connectLocalCore, diagnoseCore, safeError } from "../core/client.js";
import { registerCoreFlags, resolveCoreConfig } from "../core/config.js";
import type { CoreConfig, CoreConnection, DoctorReport, ProjectStatus } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchRuntime } from "../research/runtime.js";
import type { ConversationOutcome, ExecutionMode } from "../research/types.js";
import { runCandidateInteraction } from "./candidate-ui.js";
import { JobRuntime, type JobReadModel } from "../research/jobs.js";
import { SshRuntime } from "../research/ssh.js";
import { PluginRuntime } from "../research/plugins.js";
import { ProjectRuntime } from "../research/projects.js";
import { CapabilityRuntime } from "../research/capabilities.js";
import { alignRunToProjectStatus, approveRunGate, createResearchRun, gateLabel, RESEARCH_RUN_ENTRY, recordRunTurn, restoreResearchRun, runPrompt, runSummary, type ResearchRunState } from "../research/run.js";
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
    let activeRun: ResearchRunState | null = null;
    let startupShown = false;
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
      description: "Legacy mode command; the preview uses one unified chat mode",
      handler: modeCommand,
    });

    pi.registerCommand("research-next", {
      description: "Generate detailed candidate research directions",
      handler: directionCommand,
    });

    pi.registerCommand("doctor", { description: "检查 Research Explorer 连接", handler: doctorCommand });
    pi.registerCommand("project", { description: "选择或新建科研项目", handler: projectCommand });
    pi.registerCommand("status", { description: "查看当前科研项目状态", handler: statusCommand });
    pi.registerCommand("mode", { description: "查看或恢复统一聊天模式", handler: modeCommand });
    pi.registerCommand("next", { description: "生成详细的下一步研究候选", handler: directionCommand });
    pi.registerCommand("actions", { description: "查看 Core 当前允许的流程动作", handler: legalActionsCommand });
    pi.registerCommand("run", { description: "启动或查看自动科研任务：/run [研究目标]", handler: runCommand });
    pi.registerCommand("run-status", { description: "查看自动科研任务进度", handler: runStatusCommand });
    pi.registerCommand("pause", { description: "暂停自动科研任务", handler: pauseRunCommand });
    pi.registerCommand("continue", { description: "继续自动科研任务或批准当前门禁", handler: continueRunCommand });
    pi.registerCommand("stop", { description: "终止自动科研任务并保留结果", handler: stopRunCommand });
    pi.registerCommand("rexplore-startup", { description: "打开 Research Explorer 原生会话选择器", handler: startupCommand });

    async function startupCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      let sessions;
      try {
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        sessions = (await SessionManager.listAll()).sort((a, b) => b.modified.getTime() - a.modified.getTime()).filter(item => item.path !== ctx.sessionManager.getSessionFile()).slice(0, 12);
      }
      catch (error) { ctx.ui.notify(`读取会话历史失败：${safeError(error)}`, "error"); return; }
      const create = "新建会话 · 开始新的聊天与科研存档";
      const labels = sessions.map(item => `${compactLabel(item.name || item.firstMessage || "未命名会话", 42)} · ${compactLabel(item.cwd || "未知目录", 28)} · ${formatSessionTime(item.modified)}`);
      const selected = await ctx.ui.select("Research Explorer", [create, ...labels]);
      if (!selected) return;
      if (selected === create) { await ctx.newSession(); return; }
      const index = labels.indexOf(selected), session = index >= 0 ? sessions[index] : undefined;
      if (session) await ctx.switchSession(session.path);
    }

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
      if (!projectId) return ctx.ui.notify("旧 `/research-open` 仅用于迁移，请提供内部 Project ID。新会话无需选择第二层 Project。", "info");
      await openProject(projectId, ctx);
      if (context) pi.setSessionName(context.projectTitle);
    }

    async function projectCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      const runtime = await requireRuntime(ctx);
      if (!runtime || !context) return;
      ctx.ui.notify(`${context.projectTitle} · ${stageLabel(context.projectStatus)}\n科研状态与当前 Pi 会话绑定。`, "info");
    }

    async function statusCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      if (!context) return ctx.ui.notify("当前是自由聊天，尚未绑定科研项目。使用 /project 选择或新建项目。", "info");
      const current = context, activeClient = await requireClient(ctx);
      if (!activeClient) return;
      try {
        const runtime = new ResearchRuntime(activeClient, current.workspaceId, current.projectId);
        const [status, currentPolicy] = await Promise.all([queryProject(activeClient, current.workspaceId, current.projectId), runtime.policy()]);
        if (!status) return ctx.ui.notify("当前项目不可用。", "error");
        const policy = currentPolicy.mode === "manual" ? currentPolicy : await runtime.setMode("manual");
        bind(status, ctx, policy.mode, current.conversationSessionId);
        ctx.ui.notify(formatStatus(status), "info");
      } catch (error) {
        connectionError = safeError(error); client = null; contextVerified = false; updateUi(ctx); ctx.ui.notify(`Core unavailable: ${connectionError}`, "error");
      }
    }

    async function modeCommand(args: string, ctx: ExtensionContext): Promise<void> {
      const requested = parseMode(args);
      if (requested && requested !== "manual") ctx.ui.notify("本地预览版已停用独立 Candidate/Auto 模式。统一聊天中使用 /next 获取建议，使用 /actions 执行 Core 流程动作。", "info");
      const mode: ExecutionMode = "manual";
      const runtime = await requireRuntime(ctx);
      if (!runtime) return;
      try {
        const policy = await runtime.setMode(mode);
        if (context) { context = { ...context, mode: policy.mode, recordedAt: new Date().toISOString() }; persistContext(ctx); }
        ctx.ui.notify("当前使用统一聊天模式。需要研究建议时输入 /next。", "info");
      } catch (error) { ctx.ui.notify(`模式切换失败：${safeError(error)}`, "error"); }
    }

    async function directionCommand(args: string, ctx: ExtensionContext): Promise<void> {
      const runtime = await requireRuntime(ctx);
      if (!runtime || !context) return;
      pi.sendUserMessage([
        "请根据当前聊天与科研状态给出三个差异明确的下一步研究方向。",
        "每项说明：目标、具体下一步、理由、预计成本和主要风险。",
        "不要执行任何方向，等待我用编号、组合方案或自由文字回复。",
        args.trim() ? `附加要求：${args.trim()}` : "",
      ].filter(Boolean).join("\n"), { deliverAs: "followUp" });
    }

    async function legalActionsCommand(args: string, ctx: ExtensionContext): Promise<void> {
      const runtime = await requireRuntime(ctx);
      if (!runtime) return;
      await runCandidateInteraction({ runtime, message: args.trim() || "给出当前项目的下一步合法流程动作。", sessionId: context?.conversationSessionId ?? null, ctx, onOutcome: (outcome) => applyOutcome(outcome, ctx) });
    }

    async function runCommand(args: string, ctx: ExtensionContext): Promise<void> {
      if (activeRun && !["completed", "cancelled", "blocked"].includes(activeRun.status)) {
        ctx.ui.notify(runSummary(activeRun), "info");
        return;
      }
      const runtime = await requireRuntime(ctx);
      if (!runtime || !context) return;
      const previousBlockedGoal = activeRun?.status === "blocked" ? activeRun.goal : "";
      const goal = args.trim() || previousBlockedGoal || (await ctx.ui.input("自动科研目标", "说明要研究的问题或目标"))?.trim() || "";
      if (goal.length < 5) return ctx.ui.notify("自动科研目标至少需要 5 个字符。", "warning");
      activeRun = createResearchRun({ sessionId: ctx.sessionManager.getSessionId(), projectId: context.projectId, goal });
      const status = await runtime.status();
      activeRun = alignRunToProjectStatus(activeRun, status.project.status);
      if (activeRun.stage === "scope") {
        try { await prepareScopeForGate(ctx); }
        catch (error) {
          activeRun = { ...activeRun, status: "blocked", blocker: `无法准备研究问题：${safeError(error)}`, updatedAt: new Date().toISOString() };
          persistRun("自动科研无法建立首个研究问题。", ctx);
          return;
        }
      }
      persistRun(previousBlockedGoal ? "已从阻塞检查点重新规划自动科研任务。" : "自动科研任务已启动。", ctx);
      if (activeRun.status === "running") sendRunStage();
    }

    async function runStatusCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      if (!activeRun) return ctx.ui.notify("当前会话没有自动科研任务。使用 /run [目标] 启动。", "info");
      ctx.ui.notify(runSummary(activeRun), activeRun.status === "blocked" ? "warning" : "info");
    }

    async function pauseRunCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      if (!activeRun || activeRun.status !== "running") return ctx.ui.notify("当前没有正在运行的自动科研任务。", "info");
      activeRun = { ...activeRun, status: "paused", updatedAt: new Date().toISOString() };
      persistRun("自动科研将在当前模型步骤结束后暂停。", ctx);
    }

    async function continueRunCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      if (!activeRun) return ctx.ui.notify("当前会话没有自动科研任务。", "info");
      if (activeRun.status === "awaiting_approval") {
        if (activeRun.awaitingGate === "scope_approval") {
          const runtime = await requireRuntime(ctx);
          if (!runtime) return;
          let status = await runtime.status();
          if (status.project.status === "draft") {
            await runCandidateInteraction({ runtime, message: "批准当前已选择研究问题的范围。", sessionId: context?.conversationSessionId ?? null, ctx, onOutcome: (outcome) => applyOutcome(outcome, ctx) });
            status = await runtime.status();
          }
          if (status.project.status === "draft") return ctx.ui.notify("研究范围尚未批准，自动科研仍停在范围门禁。", "warning");
        } else if (!(await ctx.ui.confirm(`批准：${gateLabel(activeRun.awaitingGate!)}`, "批准后自动科研将进入下一阶段。该决定会写入当前会话历史。"))) return;
        activeRun = approveRunGate(activeRun);
        persistRun(`已批准${activeRun.status === "completed" ? "最终结论，任务完成" : "门禁，继续自动科研"}。`, ctx);
        if (activeRun.status === "running") sendRunStage();
        return;
      }
      if (activeRun.status === "paused") {
        activeRun = { ...activeRun, status: "running", blocker: null, updatedAt: new Date().toISOString() };
        persistRun("自动科研已继续。", ctx);
        sendRunStage();
        return;
      }
      if (activeRun.status === "blocked") return ctx.ui.notify(`${runSummary(activeRun)}\n请解决阻塞条件后重新启动任务。`, "warning");
      ctx.ui.notify(runSummary(activeRun), "info");
    }

    async function stopRunCommand(_args: string, ctx: ExtensionContext): Promise<void> {
      if (!activeRun || ["completed", "cancelled"].includes(activeRun.status)) return ctx.ui.notify("当前没有可终止的自动科研任务。", "info");
      if (!(await ctx.ui.confirm("终止自动科研？", "已有聊天、Core 状态、Job 和 Artifact 会保留。"))) return;
      activeRun = { ...activeRun, status: "cancelled", updatedAt: new Date().toISOString() };
      persistRun("自动科研任务已终止，已有结果已保留。", ctx);
    }

    function persistRun(message: string, ctx: ExtensionContext): void {
      if (!activeRun) return;
      pi.appendEntry(RESEARCH_RUN_ENTRY, activeRun);
      pi.sendMessage({ customType: "research-explorer.run-status", content: `${message}\n\n${runSummary(activeRun)}`, display: true, details: activeRun });
      updateRunUi(ctx);
    }

    function sendRunStage(): void {
      if (!activeRun || activeRun.status !== "running") return;
      pi.sendUserMessage(runPrompt(activeRun), { deliverAs: "followUp" });
    }

    async function advanceRunAfterTurn(event: unknown, ctx: ExtensionContext): Promise<void> {
      if (!activeRun || activeRun.status !== "running") return;
      const message = event as { usage?: { cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
      if (message.stopReason === "error") {
        activeRun = { ...activeRun, status: "blocked", blocker: message.errorMessage || "模型步骤失败", updatedAt: new Date().toISOString() };
        persistRun("自动科研因模型错误阻塞。", ctx);
        return;
      }
      activeRun = recordRunTurn(activeRun, Number(message.usage?.cost?.total ?? 0));
      const notice = activeRun.status === "awaiting_approval" ? `自动科研已到达人工门禁：${gateLabel(activeRun.awaitingGate!)}` : activeRun.status === "blocked" ? "自动科研已触发预算或阻塞门。" : activeRun.status === "completed" ? "自动科研任务已完成。" : "阶段完成，自动进入下一阶段。";
      persistRun(notice, ctx);
      if (activeRun.status === "running") sendRunStage();
    }

    async function prepareScopeForGate(ctx: ExtensionContext): Promise<void> {
      let runtime = activeRuntime();
      if (!runtime || !context) throw new Error("科研状态尚未建立");
      for (let step = 0; step < 3; step += 1) {
        const status = await runtime.status();
        if (status.questions.some((question) => question.status === "selected")) return;
        let outcome = await runtime.converse("自动科研正在准备研究范围，只执行零成本的问题提出或选择动作。", context.conversationSessionId, "agent");
        const candidate = outcome.candidates?.candidates.find((item) => item.kind === "action" && item.action && (item.action.type === "question.propose" || item.action.type === "question.select"));
        if (!candidate?.action || !outcome.candidates) throw new Error("Core 没有提供可自动执行的问题动作");
        outcome = await runtime.chooseCandidate({ sessionId: outcome.sessionId, candidateSetId: outcome.candidates.id, candidateId: candidate.id }, "agent");
        await applyOutcome(outcome, ctx);
        runtime = activeRuntime();
        if (!runtime) throw new Error("执行问题动作后科研状态丢失");
      }
      throw new Error("问题提出与选择未在有界步骤内完成");
    }

    pi.on("session_start", async (_event, ctx) => {
      sessionContext = ctx;
      config = resolveCoreConfig(pi);
      context = restoreContext(ctx.sessionManager.getBranch());
      activeRun = restoreResearchRun(ctx.sessionManager.getBranch());
      contextVerified = false;
      try {
        client = await dependencies.connect(config);
        connectionError = null;
        if (context) {
          const runtime = new ResearchRuntime(client, context.workspaceId, context.projectId);
          const [status, currentPolicy] = await Promise.all([runtime.status(), runtime.policy()]);
          const policy = currentPolicy.mode === "manual" ? currentPolicy : await runtime.setMode("manual");
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
      if (activeRun?.status === "running") sendRunStage();
      if (!startupShown && process.env.RESEARCH_EXPLORER_SHOW_STARTUP === "1" && ctx.mode === "tui" && ctx.hasUI) {
        startupShown = true;
        process.env.RESEARCH_EXPLORER_SHOW_STARTUP = "0";
        queueMicrotask(() => pi.sendUserMessage("/rexplore-startup", { expandPromptTemplates: true }));
      }
    });

    pi.on("input", async () => {
      return { action: "continue" as const };
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
      const runContext = activeRun && !["completed", "cancelled"].includes(activeRun.status)
        ? `An active ResearchRun is authoritative for workflow planning: stage=${activeRun.stage}, status=${activeRun.status}, goal=${activeRun.goal}. Follow its stage prompt. Never call research_converse to discover a general next step; that tool only supports question proposal, question selection, and scope approval. A Core reply saying there is no automatically advanceable action is not a workflow blocker. Use research_context, research_capability, research_job, and other relevant tools to perform the current stage.`
        : "";
      return { systemPrompt: `${event.systemPrompt}\n\n${researchContext}${runContext ? `\n\n${runContext}` : ""}` };
    });

    pi.on("turn_start", async () => {});
    pi.on("turn_end", async (_event, ctx) => {
      updateUi(ctx);
      await advanceRunAfterTurn(_event.message, ctx);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      jobMonitor.shutdown();
      sessionContext = null;
      ctx.ui.setStatus("research-explorer", undefined);
      ctx.ui.setWidget("research-explorer", undefined);
      ctx.ui.setStatus("research-jobs", undefined);
      ctx.ui.setWidget("research-jobs", undefined);
      ctx.ui.setStatus("research-run", undefined);
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
        await createProjectCommand(inferSessionTitle(ctx), ctx);
        if (!context) return null;
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
      const runtime = new ResearchRuntime(activeClient, config.workspaceId, projectId);
      const [status, currentPolicy] = await Promise.all([
        queryProject(activeClient, config.workspaceId, projectId),
        runtime.policy(),
      ]);
      if (!status) throw new Error(`Project ${projectId} is unavailable in ${config.workspaceId}`);
      const policy = currentPolicy.mode === "manual" ? currentPolicy : await runtime.setMode("manual");
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
      const [status, currentPolicy] = await Promise.all([runtime.status(), runtime.policy()]);
      const policy = currentPolicy.mode === "manual" ? currentPolicy : await runtime.setMode("manual");
      snapshot = status;
      context = contextFromStatus(status, policy.mode, outcome?.sessionId ?? context.conversationSessionId, context.jobIds, context.activeJobId);
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
        updateRunUi(ctx);
        return;
      }
      ctx.ui.setStatus("research-explorer", contextVerified ? `${modeLabel(context.mode)} · ${stageLabel(context.projectStatus)}` : "项目状态待验证");
      ctx.ui.setWidget("research-explorer", [contextVerified ? context.projectTitle : "项目状态待验证", contextVerified ? `${stageLabel(context.projectStatus)} · ${modeLabel(context.mode)}` : connected ? "正在重新连接项目" : "Core 不可用"]);
      updateJobUi(ctx);
      updateRunUi(ctx);
    }

    function updateRunUi(ctx: ExtensionContext): void {
      if (!activeRun || ["completed", "cancelled"].includes(activeRun.status)) {
        ctx.ui.setStatus("research-run", undefined);
        return;
      }
      const summary = runSummary(activeRun).split("\n");
      ctx.ui.setStatus("research-run", `${summary[1]?.replace("状态：", "") ?? activeRun.status} · ${summary[2]?.replace("阶段：", "") ?? activeRun.stage}`);
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

function actor() {
  return { id: "user:research-explorer", kind: "user", displayName: "Research Explorer user" } as const;
}

function inferSessionTitle(ctx: ExtensionContext): string {
  const named = ctx.sessionManager.getSessionName()?.trim();
  if (named && named.length >= 3) return named.slice(0, 80);
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    const value = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (value.type !== "message" || value.message?.role !== "user") continue;
    const content = value.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string").map(item => item.text).join(" ") : "";
    const cleaned = text.replace(/^\/[a-z-]+\s*/i, "").replace(/\s+/g, " ").trim();
    if (cleaned.length >= 3) return cleaned.slice(0, 80);
  }
  return `研究会话 ${ctx.sessionManager.getSessionId().slice(0, 8)}`;
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

function compactLabel(value: string, length: number): string { const text = value.replace(/\s+/g, " ").trim(); return text.length <= length ? text : `${text.slice(0, length - 1)}…`; }
function formatSessionTime(value: Date): string { return value.toISOString().replace("T", " ").slice(0, 16); }
