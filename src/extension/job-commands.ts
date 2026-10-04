import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { safeError } from "../core/client.js";
import { JobRuntime, type JobReadModel } from "../research/jobs.js";
import { promptConfirmationToken } from "./secret-input.js";

export interface JobCommandHost {
  runtime(ctx: ExtensionContext): Promise<JobRuntime | null>;
  activeJobId(): string | null;
  track(jobId: string, ctx: ExtensionContext): Promise<void>;
  refresh(jobId: string, ctx: ExtensionContext): Promise<JobReadModel | null>;
}

export function registerJobFeatures(pi: ExtensionAPI, host: JobCommandHost): void {
  pi.registerCommand("research-job-submit", {
    description: "Submit a JobSpec JSON value or @file through Core",
    handler: async (args, ctx) => {
      const runtime = await host.runtime(ctx);
      if (!runtime) return;
      const raw = await jobSpecInput(args, ctx);
      if (!raw) return;
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(raw);
      } catch {
        ctx.ui.notify("JobSpec must be valid JSON.", "error");
        return;
      }
      if (!spec || typeof spec !== "object" || Array.isArray(spec) || containsSecretField(spec)) {
        ctx.ui.notify("JobSpec must be an object and cannot contain secret/token/password fields.", "error");
        return;
      }
      const summary = jobSummary(spec);
      if (!(await ctx.ui.confirm("Submit research Job?", summary))) return;
      let confirmationToken: string | null = null;
      try {
        if (spec.dataRole === "confirmation") {
          confirmationToken = await promptConfirmationToken(ctx);
          if (!confirmationToken) return;
          if (confirmationToken.length < 32) {
            ctx.ui.notify("Confirmation token is too short.", "error");
            return;
          }
        }
        const job = await runtime.submit(spec, confirmationToken);
        await host.track(job.id, ctx);
        ctx.ui.notify(`Job submitted: ${job.id} · ${job.status}`, "info");
      } catch (error) {
        ctx.ui.notify(`Job submission failed: ${safeError(error)}`, "error");
      } finally {
        confirmationToken = null;
      }
    },
  });

  pi.registerCommand("research-job-status", {
    description: "Show Job status and Artifacts: /research-job-status [job-id]",
    handler: async (args, ctx) => {
      const jobId = args.trim() || host.activeJobId();
      if (!jobId) return ctx.ui.notify("No Job ID is available.", "warning");
      const model = await host.refresh(jobId, ctx);
      if (model) ctx.ui.notify(formatJob(model), "info");
    },
  });

  pi.registerCommand("research-job-logs", {
    description: "Show a bounded page of Job logs: /research-job-logs [job-id]",
    handler: async (args, ctx) => {
      const runtime = await host.runtime(ctx);
      const jobId = args.trim() || host.activeJobId();
      if (!runtime || !jobId) return ctx.ui.notify("No Job ID is available.", "warning");
      try {
        const page = await runtime.logs(jobId, 1, 200);
        ctx.ui.notify(formatLogs(page.logs.slice(-20)), "info");
      } catch (error) { ctx.ui.notify(`Job logs failed: ${safeError(error)}`, "error"); }
    },
  });

  pi.registerCommand("research-job-cancel", {
    description: "Request cancellation: /research-job-cancel [job-id]",
    handler: async (args, ctx) => {
      const runtime = await host.runtime(ctx);
      const jobId = args.trim() || host.activeJobId();
      if (!runtime || !jobId) return ctx.ui.notify("No Job ID is available.", "warning");
      if (!(await ctx.ui.confirm("Cancel research Job?", jobId))) return;
      try { const job = await runtime.cancel(jobId); await host.refresh(job.id, ctx); ctx.ui.notify(`Cancellation requested: ${job.id} · ${job.status}`, "info"); }
      catch (error) { ctx.ui.notify(`Job cancellation failed: ${safeError(error)}`, "error"); }
    },
  });

  pi.registerCommand("research-job-retry", {
    description: "Retry a failed/cancelled Job: /research-job-retry [job-id]",
    handler: async (args, ctx) => {
      const runtime = await host.runtime(ctx);
      const jobId = args.trim() || host.activeJobId();
      if (!runtime || !jobId) return ctx.ui.notify("No Job ID is available.", "warning");
      if (!(await ctx.ui.confirm("Retry research Job?", jobId))) return;
      try { const job = await runtime.retry(jobId); await host.track(job.id, ctx); ctx.ui.notify(`Job retried: ${job.id} · attempt ${job.currentAttempt}`, "info"); }
      catch (error) { ctx.ui.notify(`Job retry failed: ${safeError(error)}`, "error"); }
    },
  });

  pi.registerTool({
    name: "research_job",
    label: "Research Job",
    description: "Read bounded Job status/logs, or request cancellation after explicit confirmation.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("logs"), Type.Literal("cancel")]),
      jobId: Type.Optional(Type.String({ minLength: 1 })),
      fromSequence: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtime = await host.runtime(ctx);
      const jobId = params.jobId ?? host.activeJobId();
      if (!runtime || !jobId) return toolError("No Job ID is available.", "NO_JOB");
      try {
        if (params.action === "logs") {
          const page = await runtime.logs(jobId, params.fromSequence ?? 1, 100);
          return toolSuccess({ jobId, logs: page.logs.slice(0, 100), nextSequence: page.nextSequence });
        }
        if (params.action === "cancel") {
          if (!(await ctx.ui.confirm("Cancel research Job?", jobId))) return toolError("User cancelled Job cancellation.", "USER_CANCELLED");
          const job = await runtime.cancel(jobId);
          await host.refresh(jobId, ctx);
          return toolSuccess({ job });
        }
        const model = await runtime.get(jobId);
        return toolSuccess(safeJobModel(model));
      } catch (error) { return toolError(safeError(error), "CORE_ERROR"); }
    },
  });
}

function jobSpecInput(args: string, ctx: ExtensionContext): Promise<string | undefined> {
  const value = args.trim();
  if (value.startsWith("@")) {
    try { return Promise.resolve(readFileSync(resolve(ctx.cwd, value.slice(1)), "utf8")); }
    catch (error) { ctx.ui.notify(`Cannot read JobSpec: ${safeError(error)}`, "error"); return Promise.resolve(undefined); }
  }
  if (value) return Promise.resolve(value);
  return ctx.ui.editor("JobSpec JSON", JSON.stringify(exampleJobSpec(ctx.cwd), null, 2));
}

function exampleJobSpec(workspace: string) {
  return { name: "bounded analysis", dataRole: "exploration", studyId: null, execution: { kind: "bubblewrap", workspace, command: "/bin/true", args: [], env: {}, artifactPaths: [] }, resources: { cpuCores: 1, memoryMiB: 256, diskMiB: 256, gpuCount: 0 }, limits: { wallTimeMs: 60_000, cpuTimeSeconds: 30, maxOutputBytes: 100_000, maxArtifactBytes: 1_000_000 }, priority: 0, resumable: true, maxAttempts: 2, executionPhase: "general" };
}

function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => /(token|secret|password|api.?key|authorization)/i.test(key) || containsSecretField(item));
}

function jobSummary(spec: Record<string, unknown>): string {
  const resources = spec.resources as Record<string, unknown> | undefined;
  const limits = spec.limits as Record<string, unknown> | undefined;
  return `${String(spec.name ?? "unnamed")}\nrole=${String(spec.dataRole ?? "unknown")} · executor=${String((spec.execution as Record<string, unknown> | undefined)?.kind ?? "unknown")}\nCPU=${String(resources?.cpuCores ?? "?")} · memory=${String(resources?.memoryMiB ?? "?")} MiB · GPU=${String(resources?.gpuCount ?? "?")}\nwall=${String(limits?.wallTimeMs ?? "?")} ms · output=${String(limits?.maxOutputBytes ?? "?")} bytes`;
}

function safeJobModel(model: JobReadModel) { return { job: model.job, artifacts: model.artifacts.map(({ uri: _uri, ...artifact }) => artifact) }; }
function formatJob(model: JobReadModel): string { const artifacts = model.artifacts.map((item) => `${item.name} · ${item.mediaType} · ${item.bytes} bytes · ${item.contentHash.slice(0, 12)}…`).join("\n"); return `${model.job.id} · ${model.job.status} · attempt ${model.job.currentAttempt}${model.job.failureClass ? ` · ${model.job.failureClass}` : ""}${artifacts ? `\nArtifacts:\n${artifacts}` : ""}`.slice(0, 4000); }
function formatLogs(logs: Array<{ sequence: number; stream: string; message: string }>): string { return logs.length ? logs.map((item) => `${item.sequence} [${item.stream}] ${item.message}`).join("\n").slice(0, 4000) : "No Job logs."; }
function toolSuccess(value: unknown) { const text = JSON.stringify(value, null, 2); return { content: [{ type: "text" as const, text: text.slice(0, 12_000) }], details: { status: "ok" } }; }
function toolError(message: string, code: string) { return { content: [{ type: "text" as const, text: message.slice(0, 2000) }], details: { code }, isError: true }; }
