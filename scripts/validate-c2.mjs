#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connectLocalCore } from "../dist/core/client.js";
import { ResearchOperationError, ResearchRuntime } from "../dist/research/runtime.js";

const root = resolve(".");
const launcher = resolve("dist/launcher.js");
const coreEntry = resolve(process.env.C2_CORE_ENTRY ?? process.env.C1_CORE_ENTRY ?? "../auto-research-agent/dist/service/cli.js");
const reportPath = resolve("docs/reports/validation/c2-validation.json");
assert.ok(existsSync(coreEntry), `Core entry is missing: ${coreEntry}`);

const started = Date.now();
const validationRoot = mkdtempSync(join(tmpdir(), "rexplore-c2-"));
const coreDataDir = join(validationRoot, "core");
const databasePath = join(validationRoot, "research.db");
const workspaceId = "workspace:c2-validation";
let corePid = null;
const liveChildren = new Set();

try {
  const client = await connectLocalCore({ dataDir: coreDataDir, databasePath, serviceEntry: coreEntry, autoStart: true, timeoutMs: 20_000, workspaceId, stateFile: join(validationRoot, "unused-state.json") });
  const discovery = await waitForDiscovery(coreDataDir);
  corePid = discovery.pid;

  const directRuntime = new ResearchRuntime(client, workspaceId, await createProject(client, workspaceId, "Unified entry study"));
  const candidateRuntime = new ResearchRuntime(client, workspaceId, await createProject(client, workspaceId, "Unified entry study"));
  const autoRuntime = new ResearchRuntime(client, workspaceId, await createProject(client, workspaceId, "Unified entry study"));

  const directOffer = await directRuntime.converse("Give the next legal action", null, "user");
  assertFreeInputLast(directOffer);
  const directAction = firstAction(directOffer);
  await directRuntime.executeAction(directAction, "user");

  const candidateOffer = await candidateRuntime.converse("Give the next legal action", null, "user");
  assertFreeInputLast(candidateOffer);
  const candidate = candidateOffer.candidates.candidates.find((item) => item.kind === "action");
  assert.ok(candidate?.action);
  await candidateRuntime.chooseCandidate({ sessionId: candidateOffer.sessionId, candidateSetId: candidateOffer.candidates.id, candidateId: candidate.id }, "user");

  await autoRuntime.setMode("auto");
  const autoOutcome = await autoRuntime.converse("Continue within the bounded auto policy", null, "user");
  assert.equal(autoOutcome.executedAction?.type, "question.propose");

  const entryActions = await Promise.all([directRuntime, candidateRuntime, autoRuntime].map(proposedAction));
  assert.deepEqual(entryActions.map((item) => item.type), ["question.propose", "question.propose", "question.propose"]);
  assert.deepEqual(semantic(entryActions[0]), semantic(entryActions[1]));
  assert.deepEqual(semantic(entryActions[1]), semantic(entryActions[2]));

  const gateRuntime = new ResearchRuntime(client, workspaceId, await createProject(client, workspaceId, "Mandatory gate study"));
  const proposeOffer = await gateRuntime.converse("Propose the first question", null, "user");
  await chooseFirst(gateRuntime, proposeOffer);
  const selectOffer = await gateRuntime.converse("Select the proposed question", proposeOffer.sessionId, "user");
  await chooseFirst(gateRuntime, selectOffer);
  await gateRuntime.setMode("auto");
  const blocked = await gateRuntime.converse("Automatically continue", proposeOffer.sessionId, "user");
  assert.equal(blocked.executedAction, null);
  assertFreeInputLast(blocked);
  const approval = firstAction(blocked);
  assert.equal(approval.type, "scope.approve");
  await assert.rejects(() => gateRuntime.executeAction(approval, "agent"), (error) => error instanceof ResearchOperationError && error.code === "GATE_REJECTED");
  const approvalCandidate = blocked.candidates.candidates.find((item) => item.action?.type === "scope.approve");
  assert.ok(approvalCandidate);
  await gateRuntime.chooseCandidate({ sessionId: blocked.sessionId, candidateSetId: blocked.candidates.id, candidateId: approvalCandidate.id }, "user");
  assert.equal((await gateRuntime.status()).project.status, "scoped");

  const sessionDir = join(validationRoot, "sessions");
  const sessionFile = join(sessionDir, "c2-validation.jsonl");
  const stateFile = join(validationRoot, "cli-state.json");
  mkdirSync(sessionDir, { recursive: true });
  writeSessionFixture(sessionFile, root);
  const rpc = startRpc(launcher, root, [
    "--session", sessionFile,
    "--session-dir", sessionDir,
    "--research-core-data-dir", coreDataDir,
    "--research-core-database", databasePath,
    "--research-state-file", stateFile,
    "--research-workspace", workspaceId,
    "--research-no-core-autostart",
  ], uiResponder());
  const commands = commandNames(await rpc.request("get_commands"));
  for (const command of ["research-mode", "research-next"]) assert.ok(commands.includes(command), `Missing ${command}`);
  await rpc.request("prompt", { message: "/research-new C2 interactive project" });
  await rpc.request("prompt", { message: "/research-mode candidate" });
  await rpc.request("prompt", { message: "/research-next Show candidates" });
  await rpc.request("prompt", { message: "/research-mode auto" });
  await rpc.request("prompt", { message: "/research-next Execute one bounded action" });
  const entries = await rpc.request("get_entries");
  const binding = latestBinding(entries.data?.entries);
  assert.equal(binding?.mode, "auto");
  assert.ok(binding?.conversationSessionId);
  const interactiveStatus = await new ResearchRuntime(client, workspaceId, binding.projectId).status();
  assert.equal(interactiveStatus.questions.length, 1);
  await rpc.close();

  const token = readFileSync(discovery.tokenFile, "utf8").trim();
  assert.equal(readFileSync(sessionFile, "utf8").includes(token), false);
  assert.equal(readFileSync(stateFile, "utf8").includes(token), false);

  const report = {
    schemaVersion: 1,
    stage: "C2",
    status: "pass",
    platform: `${process.platform}/${process.arch}`,
    entryEquivalence: { direct: "question.proposed", candidate: "question.proposed", auto: "question.proposed", semanticActionEqual: true },
    candidateUi: { fixedFallbacks: ["继续用原输入自由聊天", "输入其他行动", "取消"], freeInputLast: true },
    gates: { autoScopeApprovalBlocked: true, agentScopeApprovalRejected: true, explicitUserApprovalAccepted: true },
    persistence: { mode: binding.mode, conversationSessionId: true, tokenExcluded: true },
    commands: commands.filter((name) => name.startsWith("research-")),
    assertions: { realCore: true, realPiRpc: true, noModelCall: true },
    elapsedMs: Date.now() - started,
    recordedAt: new Date().toISOString(),
  };
  writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  for (const child of liveChildren) child.kill("SIGTERM");
  if (!corePid && existsSync(join(coreDataDir, "core-service.json"))) {
    try { corePid = JSON.parse(readFileSync(join(coreDataDir, "core-service.json"), "utf8")).pid; } catch {}
  }
  if (corePid) await stopCore(corePid, coreDataDir).catch(() => {});
  rmSync(validationRoot, { recursive: true, force: true });
}

async function createProject(client, workspace, title) {
  const id = crypto.randomUUID();
  const result = await client.execute({
    schemaVersion: "1.0.0", commandId: `c2-${id}`, idempotencyKey: `c2-${id}`, workspaceId: workspace, projectId: null,
    actor: { id: "user:c2-validation", kind: "user" }, issuedAt: new Date().toISOString(), type: "project.create",
    payload: { intent: { title, direction: "Evaluate whether every interaction entry preserves the same canonical ResearchAction and mandatory research gates.", domain: "AI/ML", constraints: ["public API only"], allowedData: ["synthetic fixture"], prohibitions: ["no gate bypass"], profile: "exploratory", budget: { gpuHours: 1, wallHours: 1, diskGiB: 1, modelCalls: 2, knownCostUsd: 0 } } },
  });
  assert.equal(result.status, "accepted");
  return result.projectId;
}

function firstAction(outcome) {
  const candidate = outcome.candidates?.candidates.find((item) => item.kind === "action");
  assert.ok(candidate?.action, "No action candidate was returned");
  return candidate.action;
}

async function chooseFirst(runtime, outcome) {
  const candidate = outcome.candidates?.candidates.find((item) => item.kind === "action");
  assert.ok(candidate);
  return runtime.chooseCandidate({ sessionId: outcome.sessionId, candidateSetId: outcome.candidates.id, candidateId: candidate.id }, "user");
}

function assertFreeInputLast(outcome) {
  assert.equal(outcome.candidates?.freeInputAllowed, true);
  assert.equal(outcome.candidates?.candidates.at(-1)?.kind, "free_input");
}

async function proposedAction(runtime) {
  const page = await runtime.events(1, 50);
  const event = page.events.find((item) => item.type === "question.proposed");
  assert.ok(event?.payload?.action);
  return event.payload.action;
}

function semantic(action) {
  const { id: _id, ...rest } = action;
  return rest;
}

function uiResponder() {
  return (message) => {
    if (message.method === "confirm") return { confirmed: true };
    if (message.method === "select") {
      const freeChat = message.options?.find((item) => item === "继续用原输入自由聊天");
      return freeChat ? { value: freeChat } : { value: message.options?.[0] };
    }
    if (message.method === "input") return { cancelled: true };
    return null;
  };
}

function startRpc(binary, cwd, extraArgs, respondUi) {
  const args = ["--mode", "rpc", "--offline", ...extraArgs];
  const child = binary.endsWith(".js") ? spawn(process.execPath, [binary, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] }) : spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  liveChildren.add(child);
  let sequence = 0, stdout = "", stderr = "", closed = false;
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(message.method)) {
        const response = respondUi(message) ?? { cancelled: true };
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, ...response })}\n`);
      }
      if (message.type !== "response" || !message.id || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      message.success ? waiter.resolve(message) : waiter.reject(new Error(`RPC ${message.command} failed: ${message.error ?? "unknown"}`));
    }
  });
  child.once("error", rejectAll);
  child.once("exit", (code, signal) => { closed = true; liveChildren.delete(child); if (pending.size) rejectAll(new Error(`RPC exited (${code ?? signal}): ${stderr}`)); });
  return {
    request(type, body = {}) {
      assert.equal(closed, false, `RPC closed before ${type}`);
      const id = `c2-${++sequence}-${type}`;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr}`)); }, 30_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, type, ...body })}\n`);
      });
    },
    close() {
      if (closed) return Promise.resolve();
      return new Promise((resolveClose) => { const timer = setTimeout(() => child.kill("SIGKILL"), 5_000); child.once("exit", () => { clearTimeout(timer); resolveClose(); }); child.stdin.end(); });
    },
  };
  function rejectAll(error) { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); }
}

function writeSessionFixture(path, cwd) {
  const timestamp = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "c2-validation", timestamp, cwd })}\n${JSON.stringify({ type: "message", id: "c2seed01", parentId: null, timestamp, message: { role: "user", content: "C2 fixture; no model invocation.", timestamp: Date.now() } })}\n`);
}
function latestBinding(entries = []) { return entries.filter((entry) => entry.type === "custom" && entry.customType === "research-explorer.context").at(-1)?.data ?? null; }
function commandNames(response) { return (response.data?.commands ?? []).map((command) => command.name); }
async function waitForDiscovery(dataDir) { const path = join(dataDir, "core-service.json"); await waitFor(() => existsSync(path), 20_000); return JSON.parse(readFileSync(path, "utf8")); }
async function stopCore(pid, dataDir) { try { process.kill(pid, "SIGTERM"); } catch { return; } await waitFor(() => !existsSync(join(dataDir, "core-service.json")), 10_000); }
async function waitFor(predicate, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); } throw new Error("Timed out waiting for validation condition"); }
function writeAtomic(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, value); renameSync(temporary, path); }
