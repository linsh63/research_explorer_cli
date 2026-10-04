import { safeError } from "../core/client.js";
import { JobRuntime, type JobArtifact, type JobRecord } from "../research/jobs.js";

export interface MonitoredJob {
  job: JobRecord;
  artifacts: JobArtifact[];
  lastLogSequence: number;
  lastLog: string | null;
  connection: "connected" | "reconnecting" | "stopped";
  error: string | null;
}

export class JobMonitor {
  private readonly controllers = new Map<string, AbortController>();
  private readonly states = new Map<string, MonitoredJob>();

  constructor(private readonly onChange: (jobs: MonitoredJob[]) => void) {}

  list(): MonitoredJob[] { return [...this.states.values()].sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt)); }

  async restore(runtime: JobRuntime, jobIds: string[]): Promise<void> {
    for (const jobId of [...new Set(jobIds)].slice(-100)) {
      try {
        const model = await runtime.get(jobId);
        const logs = await runtime.logs(jobId, 1, 500);
        const last = logs.logs.at(-1);
        this.states.set(jobId, { job: model.job, artifacts: model.artifacts, lastLogSequence: last?.sequence ?? 0, lastLog: last?.message ?? null, connection: "stopped", error: null });
        if (!terminal(model.job.status)) this.start(runtime, jobId);
      } catch (error) {
        this.states.delete(jobId);
      }
    }
    this.emit();
  }

  async track(runtime: JobRuntime, jobId: string): Promise<void> {
    const model = await runtime.get(jobId);
    this.states.set(jobId, { job: model.job, artifacts: model.artifacts, lastLogSequence: 0, lastLog: null, connection: "stopped", error: null });
    this.emit();
    if (!terminal(model.job.status)) this.start(runtime, jobId);
  }

  async refresh(runtime: JobRuntime, jobId: string): Promise<MonitoredJob> {
    const model = await runtime.get(jobId);
    const existing = this.states.get(jobId);
    const next: MonitoredJob = { job: model.job, artifacts: model.artifacts, lastLogSequence: existing?.lastLogSequence ?? 0, lastLog: existing?.lastLog ?? null, connection: terminal(model.job.status) ? "stopped" : existing?.connection ?? "stopped", error: null };
    this.states.set(jobId, next);
    if (terminal(model.job.status)) this.stop(jobId);
    this.emit();
    return next;
  }

  stop(jobId: string): void {
    this.controllers.get(jobId)?.abort();
    this.controllers.delete(jobId);
    const state = this.states.get(jobId);
    if (state) state.connection = "stopped";
  }

  shutdown(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  reset(): void {
    this.shutdown();
    this.states.clear();
    this.emit();
  }

  private start(runtime: JobRuntime, jobId: string): void {
    if (this.controllers.has(jobId)) return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    void this.run(runtime, jobId, controller).finally(() => {
      if (this.controllers.get(jobId) === controller) this.controllers.delete(jobId);
    });
  }

  private async run(runtime: JobRuntime, jobId: string, controller: AbortController): Promise<void> {
    let delayMs = 250;
    while (!controller.signal.aborted) {
      const state = this.states.get(jobId);
      if (!state || terminal(state.job.status)) return;
      state.connection = delayMs === 250 ? "connected" : "reconnecting";
      state.error = null;
      this.emit();
      try {
        for await (const event of runtime.stream(jobId, state.lastLogSequence + 1, controller.signal)) {
          if (event.event === "job-log") {
            const log = event.data as { sequence?: number; message?: string };
            if (typeof log.sequence === "number") state.lastLogSequence = Math.max(state.lastLogSequence, log.sequence);
            if (typeof log.message === "string") state.lastLog = log.message.slice(0, 500);
            this.emit();
          } else if (event.event === "research-event") {
            const refreshed = await runtime.get(jobId);
            state.job = refreshed.job;
            state.artifacts = refreshed.artifacts;
            this.emit();
            if (terminal(state.job.status)) { this.stop(jobId); return; }
          }
        }
        if (!controller.signal.aborted) throw new Error("Core event stream ended");
      } catch (error) {
        if (controller.signal.aborted) return;
        state.connection = "reconnecting";
        state.error = safeError(error);
        this.emit();
        try {
          const refreshed = await runtime.get(jobId);
          state.job = refreshed.job;
          state.artifacts = refreshed.artifacts;
          if (terminal(state.job.status)) { this.stop(jobId); this.emit(); return; }
        } catch {}
        await delay(delayMs, controller.signal);
        delayMs = Math.min(delayMs * 2, 5_000);
      }
    }
  }

  private emit(): void { this.onChange(this.list()); }
}

export function terminal(status: JobRecord["status"]): boolean { return status === "succeeded" || status === "failed" || status === "cancelled"; }

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolveDelay(); }, { once: true });
  });
}
