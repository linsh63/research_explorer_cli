import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { connectLocalCore, diagnoseCore, safeError } from "../core/client.js";
import { registerCoreFlags, resolveCoreConfig } from "../core/config.js";
import type { CoreConfig, CoreConnection, DoctorReport, ProjectStatus } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import { ResearchRuntime } from "../research/runtime.js";
import type { ConversationOutcome, ExecutionMode } from "../research/types.js";
import { runCandidateInteraction } from "./candidate-ui.js";
import {
  contextFromStatus,
  readRecentContext,
  RESEARCH_EXPLORER_ENTRY,
  restoreContext,
  type ResearchContextEntry,
  writeRecentContext,
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

    registerResearchTools(pi, {
      runtime: activeRuntime,
      sessionId: () => context?.conversationSessionId ?? null,
      onOutcome: applyOutcome,
    });

    pi.registerEntryRenderer<ResearchContextEntry>(RESEARCH_EXPLORER_ENTRY, (entry, { expanded }, theme) => {
      const data = entry.data;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      if (!data) {
        box.addChild(new Text(theme.fg("warning", "[Research Explorer] Invalid Project context"), 0, 0));
        return box;
      }
      box.addChild(new Text(`${theme.fg("accent", "[Research Explorer]")} ${data.projectTitle} · ${data.projectStatus} · ${data.mode ?? "manual"}`, 0, 0));
      if (expanded) {
        box.addChild(new Text(theme.fg("dim", `${data.workspaceId} · ${data.projectId} · ${data.recordedAt}`), 0, 0));
      }
      return box;
    });

    pi.registerCommand("research-about", {
      description: "Show Research Explorer connection and Project context",
      handler: async (_args, ctx) => {
        updateUi(ctx);
        ctx.ui.notify(context ? `Research Explorer C2 · ${context.projectTitle} · ${context.mode}` : "Research Explorer C2 · no Project selected", "info");
      },
    });

    pi.registerCommand("research-doctor", {
      description: "Check Core discovery, authentication and version compatibility",
      handler: async (_args, ctx) => {
        const report = await dependencies.diagnose(config);
        if (report.status === "connected") {
          client = await dependencies.connect(config);
          connectionError = null;
          if (context) {
            try {
              const runtime = new ResearchRuntime(client, context.workspaceId, context.projectId);
              const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
              if (status) {
                snapshot = status;
                context = contextFromStatus(status, policy.mode, context.conversationSessionId);
                contextVerified = true;
              }
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
      },
    });

    pi.registerCommand("research-new", {
      description: "Create and bind a new research Project: /research-new <title>",
      handler: async (args, ctx) => {
        const title = args.trim() || (await ctx.ui.input("Research Project title", "At least 3 characters"))?.trim() || "";
        if (title.length < 3) {
          ctx.ui.notify("A Project title of at least 3 characters is required.", "warning");
          return;
        }
        const activeClient = await requireClient(ctx);
        if (!activeClient) return;
        let result;
        try {
          result = await activeClient.execute<{ project?: unknown }>({
            schemaVersion: PUBLIC_SCHEMA_VERSION,
            commandId: `cli-${randomUUID()}`,
            idempotencyKey: `cli-project-${randomUUID()}`,
            workspaceId: config.workspaceId,
            projectId: null,
            actor: actor(),
            issuedAt: new Date().toISOString(),
            type: "project.create",
            payload: {
              intent: {
                title,
                direction: `Investigate ${title} through a concrete, falsifiable research question and a reproducible evaluation.`,
                domain: "AI/ML",
                constraints: [],
                allowedData: [],
                prohibitions: [],
                profile: "exploratory",
                budget: { gpuHours: 1, wallHours: 2, diskGiB: 2, modelCalls: 5, knownCostUsd: 0 },
              },
            },
          });
        } catch (error) {
          connectionError = safeError(error);
          client = null;
          updateUi(ctx);
          ctx.ui.notify(`Project creation failed: ${connectionError}`, "error");
          return;
        }
        if (result.status !== "accepted" || !result.projectId) {
          ctx.ui.notify(result.error?.message ?? "Core rejected Project creation.", "error");
          return;
        }
        let status;
        try {
          status = await queryProject(activeClient, config.workspaceId, result.projectId);
        } catch (error) {
          connectionError = safeError(error);
          client = null;
          updateUi(ctx);
          ctx.ui.notify(`Project was created but Core became unavailable: ${connectionError}`, "error");
          return;
        }
        if (!status) {
          ctx.ui.notify("Project was created but its status could not be loaded.", "error");
          return;
        }
        bind(status, ctx, "manual");
        ctx.ui.notify(`Created and opened ${status.project.title}.`, "info");
      },
    });

    pi.registerCommand("research-open", {
      description: "Open a Project by ID: /research-open <project-id>",
      handler: async (args, ctx) => {
        const projectId = args.trim() || (await ctx.ui.input("Project ID", "project-…"))?.trim() || "";
        if (!projectId) {
          ctx.ui.notify("A Project ID is required. Project listing awaits the public workspace.projects API.", "warning");
          return;
        }
        const activeClient = await requireClient(ctx);
        if (!activeClient) return;
        let status;
        let mode: ExecutionMode;
        try {
          status = await queryProject(activeClient, config.workspaceId, projectId);
          mode = (await new ResearchRuntime(activeClient, config.workspaceId, projectId).policy()).mode;
        } catch (error) {
          connectionError = safeError(error);
          client = null;
          updateUi(ctx);
          ctx.ui.notify(`Core unavailable: ${connectionError}`, "error");
          return;
        }
        if (!status) {
          ctx.ui.notify(`Project ${projectId} was not found in ${config.workspaceId}.`, "error");
          return;
        }
        bind(status, ctx, mode, null);
        ctx.ui.notify(`Opened ${status.project.title}.`, "info");
      },
    });

    pi.registerCommand("research-status", {
      description: "Refresh and show the active research Project",
      handler: async (_args, ctx) => {
        if (!context) {
          ctx.ui.notify("No Project is selected. Use /research-new or /research-open <project-id>.", "warning");
          return;
        }
        const current = context;
        const activeClient = await requireClient(ctx);
        if (!activeClient) return;
        let status;
        let mode: ExecutionMode;
        try {
          status = await queryProject(activeClient, current.workspaceId, current.projectId);
          mode = (await new ResearchRuntime(activeClient, current.workspaceId, current.projectId).policy()).mode;
        } catch (error) {
          connectionError = safeError(error);
          client = null;
          contextVerified = false;
          updateUi(ctx);
          ctx.ui.notify(`Core unavailable: ${connectionError}`, "error");
          return;
        }
        if (!status) {
          ctx.ui.notify("The selected Project is unavailable or belongs to another Workspace.", "error");
          return;
        }
        bind(status, ctx, mode, current.conversationSessionId);
        ctx.ui.notify(formatStatus(status), "info");
      },
    });

    pi.registerCommand("research-mode", {
      description: "Set research interaction mode: /research-mode manual|candidate|auto",
      handler: async (args, ctx) => {
        let mode = parseMode(args);
        if (!mode) {
          const selected = await ctx.ui.select("Research interaction mode", ["manual", "candidate", "auto"]);
          mode = parseMode(selected ?? "");
        }
        if (!mode) return;
        const runtime = await requireRuntime(ctx);
        if (!runtime) return;
        if (mode === "auto") {
          const confirmed = await ctx.ui.confirm(
            "Enable bounded auto mode?",
            "Core may execute at most one zero-cost, permission-free question action per turn. Mandatory approvals remain blocked.",
          );
          if (!confirmed) return;
        }
        try {
          const policy = await runtime.setMode(mode);
          if (context) {
            context = { ...context, mode: policy.mode, recordedAt: new Date().toISOString() };
            persistContext(ctx);
          }
          ctx.ui.notify(`Research mode set to ${policy.mode}.`, "info");
        } catch (error) {
          ctx.ui.notify(`Mode change failed: ${safeError(error)}`, "error");
        }
      },
    });

    pi.registerCommand("research-next", {
      description: "Ask Core for the next legal research action",
      handler: async (args, ctx) => {
        const runtime = await requireRuntime(ctx);
        if (!runtime) return;
        await runCandidateInteraction({
          runtime,
          message: args.trim() || "给出当前项目的下一步合法研究行动。",
          sessionId: context?.conversationSessionId ?? null,
          ctx,
          onOutcome: (outcome) => applyOutcome(outcome, ctx),
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      config = resolveCoreConfig(pi);
      context = restoreContext(ctx.sessionManager.getBranch()) ?? readRecentContext(config.stateFile);
      contextVerified = false;
      try {
        client = await dependencies.connect(config);
        connectionError = null;
        if (context) {
          const runtime = new ResearchRuntime(client, context.workspaceId, context.projectId);
          const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
          if (status) {
            snapshot = status;
            context = contextFromStatus(status, policy.mode, context.conversationSessionId);
            contextVerified = true;
          }
          else context = null;
        }
      } catch (error) {
        client = null;
        connectionError = safeError(error);
      }
      updateUi(ctx);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension" || event.streamingBehavior || context?.mode === "manual" || !context) {
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
        ? `Research Explorer C2 Project snapshot: title=${context.projectTitle}; id=${context.projectId}; workspace=${context.workspaceId}; status=${snapshot?.project.status ?? context.projectStatus}; mode=${context.mode}; questions=${snapshot?.questions.length ?? 0}; events=${snapshot?.persistence.eventCount ?? 0}. Use research tools for current Core state. All mutations must use Core ResearchAction paths. Never claim a gate passed unless Core confirms it.`
        : context
          ? `Research Explorer C2 restored an unverified Project binding for ${context.projectId}, but current Core state is unavailable. Do not rely on its saved title or status and do not claim that research state was read or changed.`
          : `Research Explorer C2 has no active Project${connectionError ? " and Core is unavailable" : ""}. Do not claim that research state was read or changed.`;
      return { systemPrompt: `${event.systemPrompt}\n\n${researchContext}` };
    });

    pi.on("turn_start", async (_event, ctx) => ctx.ui.setStatus("research-explorer", "C2 · Pi turn running"));
    pi.on("turn_end", async (_event, ctx) => updateUi(ctx));
    pi.on("session_shutdown", async (_event, ctx) => {
      ctx.ui.setStatus("research-explorer", undefined);
      ctx.ui.setWidget("research-explorer", undefined);
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
          context = contextFromStatus(status, policy.mode, context.conversationSessionId);
          contextVerified = true;
          persistContext(ctx);
        } catch (error) {
          ctx.ui.notify(`Project refresh failed: ${safeError(error)}`, "error");
          return null;
        }
      }
      return runtime;
    }

    async function applyOutcome(outcome: ConversationOutcome | null, ctx: ExtensionContext): Promise<void> {
      const runtime = activeRuntime();
      if (!runtime || !context) return;
      const [status, policy] = await Promise.all([runtime.status(), runtime.policy()]);
      snapshot = status;
      context = contextFromStatus(status, outcome?.policy.mode ?? policy.mode, outcome?.sessionId ?? context.conversationSessionId);
      contextVerified = true;
      persistContext(ctx);
    }

    function bind(status: ProjectStatus, ctx: ExtensionContext, mode: ExecutionMode = "manual", sessionId: string | null = null): void {
      snapshot = status;
      context = contextFromStatus(status, mode, sessionId);
      contextVerified = true;
      persistContext(ctx);
    }

    function persistContext(ctx: ExtensionContext): void {
      if (!context) return;
      pi.appendEntry(RESEARCH_EXPLORER_ENTRY, context);
      writeRecentContext(config.stateFile, context);
      updateUi(ctx);
    }

    function updateUi(ctx: ExtensionContext): void {
      const connected = client !== null;
      ctx.ui.setTitle(context ? `Research Explorer · ${context.projectTitle}` : "Research Explorer");
      ctx.ui.setStatus(
        "research-explorer",
        context && contextVerified ? `C2 · ${context.mode} · ${context.projectStatus} · ${shortId(context.projectId)}` : context ? `C2 · unverified · ${shortId(context.projectId)}` : connected ? "C2 · Core connected" : "C2 · Core unavailable",
      );
      ctx.ui.setWidget("research-explorer", context
        ? ["Research Explorer C2", contextVerified ? context.projectTitle : "Saved Project binding (unverified)", `${contextVerified ? `${context.projectStatus} · ${context.mode}` : "Core unavailable"} · ${context.workspaceId}`, context.projectId]
        : ["Research Explorer C2", connected ? "Core connected" : "Core unavailable", config?.workspaceId ?? "workspace:default", connectionError ? truncate(connectionError, 120) : "No Project selected"]);
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

function formatDoctor(report: DoctorReport): string {
  if (report.status === "disconnected") return `Core disconnected · ${report.error ?? "unknown error"}`;
  return `Core connected · service ${report.serviceVersion} · schema ${report.schemaVersion} · ${report.platform ?? "platform unknown"} · ${report.offline ? "offline" : "network enabled"}`;
}

function formatStatus(status: ProjectStatus): string {
  return `${status.project.title} · ${status.project.status} · ${status.questions.length} question(s) · ${status.persistence.eventCount} event(s)`;
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
