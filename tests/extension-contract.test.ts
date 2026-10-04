import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResearchExplorerExtension, RESEARCH_EXPLORER_ENTRY } from "../src/extension/index.js";
import { writeRecentContext } from "../src/extension/state.js";
import type { CoreConnection, DoctorReport, ProjectStatus } from "../src/core/types.js";

function projectStatus(overrides: Partial<ProjectStatus["project"]> = {}): ProjectStatus {
  return {
    schemaVersion: "1.0.0",
    workspaceId: "workspace:default",
    project: {
      id: "project-c1",
      title: "C1 Project",
      direction: "Investigate a concrete and falsifiable C1 research question.",
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

function fakeClient(status = projectStatus()): CoreConnection {
  return {
    baseUrl: "http://127.0.0.1:4321",
    capabilities: { serviceVersion: "1.0.0", schemaVersion: "1.0.0", endpoints: [], offline: true, startedAt: "now" },
    async health() { return { status: "ok", serviceVersion: "1.0.0", schemaVersion: "1.0.0", offline: true }; },
    async execute() { return { status: "accepted", projectId: status.project.id, data: { project: status.project }, error: null }; },
    async query() { return { status: "ok", projectId: status.project.id, data: status, error: null }; },
  };
}

function harness(options: { entries?: unknown[]; flags?: Record<string, boolean | string>; client?: CoreConnection; connectError?: Error } = {}) {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const renderers = new Map<string, any>();
  const registeredFlags = new Set<string>();
  const flags = new Map(Object.entries(options.flags ?? {}));
  const appended: Array<{ type: string; data: unknown }> = [];
  const uiCalls: any[][] = [];
  const client = options.client ?? fakeClient();
  const doctor: DoctorReport = {
    status: "connected",
    serviceVersion: "1.0.0",
    schemaVersion: "1.0.0",
    baseUrl: client.baseUrl,
    offline: true,
    platform: "linux/x64",
    autoStart: true,
    serviceEntry: "/core.js",
    error: null,
  };
  const pi = {
    registerFlag: (name: string, value: { default?: boolean | string }) => {
      registeredFlags.add(name);
      if (!flags.has(name) && value.default !== undefined) flags.set(name, value.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, value: unknown) => commands.set(name, value),
    registerEntryRenderer: (name: string, value: unknown) => renderers.set(name, value),
    on: (name: string, value: unknown) => handlers.set(name, value),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
  };
  createResearchExplorerExtension({
    connect: async () => {
      if (options.connectError) throw options.connectError;
      return client;
    },
    diagnose: async () => doctor,
  })(pi as any);
  const ctx = {
    sessionManager: { getBranch: () => options.entries ?? [] },
    ui: {
      input: async () => undefined,
      notify: (...args: unknown[]) => uiCalls.push(["notify", ...args]),
      setTitle: (...args: unknown[]) => uiCalls.push(["title", ...args]),
      setStatus: (...args: unknown[]) => uiCalls.push(["status", ...args]),
      setWidget: (...args: unknown[]) => uiCalls.push(["widget", ...args]),
    },
  };
  return { commands, handlers, renderers, registeredFlags, flags, appended, uiCalls, ctx };
}

test("C1 registers the bounded Project commands and Core flags", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["research-about", "research-doctor", "research-new", "research-open", "research-status"]);
  assert.ok(h.renderers.has(RESEARCH_EXPLORER_ENTRY));
  for (const flag of ["research-core-data-dir", "research-core-database", "research-core-entry", "research-no-core-autostart", "research-workspace", "research-state-file"]) {
    assert.ok(h.registeredFlags.has(flag), flag);
  }
  for (const event of ["session_start", "before_agent_start", "turn_start", "turn_end", "session_shutdown"]) {
    assert.ok(h.handlers.has(event), event);
  }
});

test("research-new creates, verifies and persists a non-sensitive Project binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c1-test-"));
  try {
    const stateFile = join(directory, "state.json");
    const h = harness({ flags: { "research-state-file": stateFile } });
    await h.handlers.get("session_start")({}, h.ctx);
    await h.commands.get("research-new").handler("C1 Project", h.ctx);
    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0]?.type, RESEARCH_EXPLORER_ENTRY);
    const serialized = JSON.stringify(h.appended[0]);
    assert.doesNotMatch(serialized, /token|secret|password|bearer|authorization/i);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).projectId, "project-c1");
    assert.ok(h.uiCalls.some((call) => call[0] === "title" && String(call[1]).includes("C1 Project")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session start restores recent binding and refreshes it from Core", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c1-restore-"));
  try {
    const stateFile = join(directory, "state.json");
    writeRecentContext(stateFile, {
      schemaVersion: 1,
      phase: "C1",
      workspaceId: "workspace:default",
      projectId: "project-c1",
      projectTitle: "Stale title",
      projectStatus: "draft",
      recordedAt: "earlier",
    });
    const h = harness({ flags: { "research-state-file": stateFile }, client: fakeClient(projectStatus({ title: "Refreshed title", status: "scoped" })) });
    await h.handlers.get("session_start")({}, h.ctx);
    assert.ok(h.uiCalls.some((call) => call[0] === "widget" && JSON.stringify(call).includes("Refreshed title")));
    const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "base" }, h.ctx);
    assert.match(prompt.systemPrompt, /Refreshed title/);
    assert.match(prompt.systemPrompt, /scoped/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary C1 context injection makes no state-change claim without a Project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c1-empty-"));
  try {
    const h = harness({ flags: { "research-state-file": join(directory, "state.json") } });
    await h.handlers.get("session_start")({}, h.ctx);
    const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "base" }, h.ctx);
    assert.match(prompt.systemPrompt, /no active Project/);
    assert.match(prompt.systemPrompt, /Do not claim/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an offline restore keeps identity but treats saved Project status as unverified", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rexplore-c1-degraded-"));
  try {
    const saved = {
      schemaVersion: 1,
      phase: "C1",
      workspaceId: "workspace:default",
      projectId: "project-c1",
      projectTitle: "Untrusted saved title",
      projectStatus: "scoped",
      recordedAt: "earlier",
    };
    const h = harness({
      entries: [{ type: "custom", customType: RESEARCH_EXPLORER_ENTRY, data: saved }],
      flags: { "research-state-file": join(directory, "state.json") },
      connectError: new Error("Bearer abcdefghijklmnopqrstuvwxyz123456 is unavailable"),
    });
    await h.handlers.get("session_start")({}, h.ctx);
    const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "base" }, h.ctx);
    assert.match(prompt.systemPrompt, /unverified Project binding/);
    assert.doesNotMatch(prompt.systemPrompt, /Untrusted saved title|Core reports status scoped/);
    assert.doesNotMatch(JSON.stringify(h.uiCalls), /abcdefghijklmnopqrstuvwxyz123456/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
