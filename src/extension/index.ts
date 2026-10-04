import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { connectLocalCore, diagnoseCore, safeError } from "../core/client.js";
import { registerCoreFlags, resolveCoreConfig } from "../core/config.js";
import type { CoreConfig, CoreConnection, DoctorReport, ProjectStatus } from "../core/types.js";
import { PUBLIC_SCHEMA_VERSION } from "../core/types.js";
import {
  contextFromStatus,
  readRecentContext,
  RESEARCH_EXPLORER_ENTRY,
  restoreContext,
  type ResearchContextEntry,
  writeRecentContext,
} from "./state.js";

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

    pi.registerEntryRenderer<ResearchContextEntry>(RESEARCH_EXPLORER_ENTRY, (entry, { expanded }, theme) => {
      const data = entry.data;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      if (!data) {
        box.addChild(new Text(theme.fg("warning", "[Research Explorer] Invalid Project context"), 0, 0));
        return box;
      }
      box.addChild(new Text(`${theme.fg("accent", "[Research Explorer]")} ${data.projectTitle} · ${data.projectStatus}`, 0, 0));
      if (expanded) {
        box.addChild(new Text(theme.fg("dim", `${data.workspaceId} · ${data.projectId} · ${data.recordedAt}`), 0, 0));
      }
      return box;
    });

    pi.registerCommand("research-about", {
      description: "Show Research Explorer connection and Project context",
      handler: async (_args, ctx) => {
        updateUi(ctx);
        ctx.ui.notify(context ? `Research Explorer C1 · ${context.projectTitle}` : "Research Explorer C1 · no Project selected", "info");
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
            const status = await queryProject(client, context.workspaceId, context.projectId);
            if (status) {
              context = contextFromStatus(status);
              contextVerified = true;
            }
          }
        } else {
          client = null;
          connectionError = report.error;
        }
        updateUi(ctx);
        ctx.ui.notify(formatDoctor(report), report.status === "connected" ? "info" : "error");
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
        const status = await queryProject(activeClient, config.workspaceId, result.projectId);
        if (!status) {
          ctx.ui.notify("Project was created but its status could not be loaded.", "error");
          return;
        }
        bind(status, ctx);
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
        const status = await queryProject(activeClient, config.workspaceId, projectId);
        if (!status) {
          ctx.ui.notify(`Project ${projectId} was not found in ${config.workspaceId}.`, "error");
          return;
        }
        bind(status, ctx);
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
        const activeClient = await requireClient(ctx);
        if (!activeClient) return;
        const status = await queryProject(activeClient, context.workspaceId, context.projectId);
        if (!status) {
          ctx.ui.notify("The selected Project is unavailable or belongs to another Workspace.", "error");
          return;
        }
        bind(status, ctx);
        ctx.ui.notify(formatStatus(status), "info");
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
          const status = await queryProject(client, context.workspaceId, context.projectId);
          if (status) {
            context = contextFromStatus(status);
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

    pi.on("before_agent_start", async (event) => {
      const researchContext = context && contextVerified
        ? `Research Explorer C1 is connected to Project ${context.projectTitle} (${context.projectId}) in ${context.workspaceId}; Core reports status ${context.projectStatus}. C1 provides Project context only.`
        : context
          ? `Research Explorer C1 restored an unverified Project binding for ${context.projectId}, but current Core state is unavailable. Do not rely on its saved title or status and do not claim that research state was read or changed.`
          : `Research Explorer C1 has no active Project${connectionError ? " and Core is unavailable" : ""}. Do not claim that research state was read or changed.`;
      return { systemPrompt: `${event.systemPrompt}\n\n${researchContext}` };
    });

    pi.on("turn_start", async (_event, ctx) => ctx.ui.setStatus("research-explorer", "C1 · Pi turn running"));
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

    function bind(status: ProjectStatus, ctx: ExtensionContext): void {
      context = contextFromStatus(status);
      contextVerified = true;
      pi.appendEntry(RESEARCH_EXPLORER_ENTRY, context);
      writeRecentContext(config.stateFile, context);
      updateUi(ctx);
    }

    function updateUi(ctx: ExtensionContext): void {
      const connected = client !== null;
      ctx.ui.setTitle(context ? `Research Explorer · ${context.projectTitle}` : "Research Explorer");
      ctx.ui.setStatus(
        "research-explorer",
        context && contextVerified ? `C1 · ${context.projectStatus} · ${shortId(context.projectId)}` : context ? `C1 · unverified · ${shortId(context.projectId)}` : connected ? "C1 · Core connected" : "C1 · Core unavailable",
      );
      ctx.ui.setWidget("research-explorer", context
        ? ["Research Explorer C1", contextVerified ? context.projectTitle : "Saved Project binding (unverified)", `${contextVerified ? context.projectStatus : "Core unavailable"} · ${context.workspaceId}`, context.projectId]
        : ["Research Explorer C1", connected ? "Core connected" : "Core unavailable", config?.workspaceId ?? "workspace:default", connectionError ? truncate(connectionError, 120) : "No Project selected"]);
    }
  };
}

export default createResearchExplorerExtension();

async function queryProject(client: CoreConnection, workspaceId: string, projectId: string): Promise<ProjectStatus | null> {
  try {
    const result = await client.query<ProjectStatus>({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      queryId: `cli-${randomUUID()}`,
      type: "project.status",
      workspaceId,
      projectId,
      actor: actor(),
    });
    return result.status === "ok" && result.data ? result.data : null;
  } catch {
    return null;
  }
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
