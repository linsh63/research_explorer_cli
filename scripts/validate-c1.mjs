#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(".");
const launcher = resolve("dist/launcher.js");
const coreEntry = resolve(process.env.C1_CORE_ENTRY ?? "../auto-research-agent/dist/service/cli.js");
const reportPath = resolve("docs/reports/validation/c1-validation.json");
const cleanNetworkEnv = { ...process.env };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete cleanNetworkEnv[key];
assert(existsSync(coreEntry), `Core entry is missing: ${coreEntry}. Build Core or set C1_CORE_ENTRY.`);

const started = Date.now();
const validationRoot = mkdtempSync(join(tmpdir(), "rexplore-c1-"));
const coreDataDir = join(validationRoot, "core");
const databasePath = join(validationRoot, "research.db");
const stateFile = join(validationRoot, "state.json");
const sessionDir = join(validationRoot, "sessions");
const sessionFile = join(sessionDir, "c1-validation.jsonl");
const workspaceId = "workspace:c1-validation";
let activeCorePid = null;
const liveRpcChildren = new Set();

try {
  mkdirSync(sessionDir, { recursive: true });
  writeSessionFixture(sessionFile, root);
  const commonFlags = coreFlags({ coreDataDir, databasePath, stateFile, workspaceId, coreEntry });

  const first = startRpc(launcher, root, ["--session", sessionFile, "--session-dir", sessionDir, ...commonFlags]);
  const commands = commandNames(await first.request("get_commands"));
  for (const command of ["research-doctor", "research-new", "research-open", "research-status"]) {
    assert(commands.includes(command), `Missing C1 command: ${command}`);
  }
  const doctor = await first.request("prompt", { message: "/research-doctor" });
  assert(doctor.data?.disposition === "handled", "Doctor command was not handled");
  const created = await first.request("prompt", { message: "/research-new C1 validation project" });
  assert(created.data?.disposition === "handled", "Project creation command was not handled");
  const entries = await first.request("get_entries");
  const binding = latestBinding(entries.data?.entries);
  const failedDiscovery = existsSync(join(coreDataDir, "core-service.json")) ? JSON.parse(readFileSync(join(coreDataDir, "core-service.json"), "utf8")) : null;
  assert(binding, `Project binding was not written to the Pi session: ${JSON.stringify({ entries: entries.data?.entries, discovery: failedDiscovery, pidAlive: failedDiscovery ? pidAlive(failedDiscovery.pid) : false, state: existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null, events: first.events() })}`);
  assert(binding.workspaceId === workspaceId, "Project binding used the wrong Workspace");
  assert(!existsSync(stateFile), "A fresh session must not write the deprecated global recent-Project state");
  const discovery = await waitForDiscovery(coreDataDir);
  activeCorePid = discovery.pid;
  const statusBeforeRestart = await queryStatus(discovery, workspaceId, binding.projectId);
  assert(statusBeforeRestart.project.id === binding.projectId, "Core did not persist the created Project");
  await first.close();

  await stopCore(activeCorePid, coreDataDir);
  activeCorePid = null;
  const resumed = startRpc(launcher, root, ["--session", sessionFile, "--session-dir", sessionDir, ...commonFlags]);
  const refreshed = await resumed.request("prompt", { message: "/research-status" });
  assert(refreshed.data?.disposition === "handled", "Project status command was not handled after restart");
  const resumedEntries = await resumed.request("get_entries");
  assert(latestBinding(resumedEntries.data?.entries)?.projectId === binding.projectId, "Pi session did not restore the Project binding");
  const restartedDiscovery = await waitForDiscovery(coreDataDir);
  activeCorePid = restartedDiscovery.pid;
  assert(activeCorePid !== discovery.pid, "Core Service did not restart with a new process");
  const statusAfterRestart = await queryStatus(restartedDiscovery, workspaceId, binding.projectId);
  assert(statusAfterRestart.project.id === binding.projectId, "Core restart lost Project state");
  await resumed.close();

  const sessionText = readFileSync(sessionFile, "utf8");
  const token = readFileSync(restartedDiscovery.tokenFile, "utf8").trim();
  assert(!sessionText.includes(token), "Core bearer token leaked into the Pi session");

  const packed = packProject(join(validationRoot, "pack"));
  const installed = await verifyPackedInstall(packed, join(validationRoot, "consumer"), {
    coreDataDir,
    databasePath,
    stateFile,
    workspaceId,
    projectId: binding.projectId,
  });

  const report = {
    schemaVersion: 1,
    stage: "C1",
    status: "pass",
    product: "Research Explorer",
    platform: `${process.platform}/${process.arch}`,
    core: { serviceVersion: restartedDiscovery.capabilities.serviceVersion, schemaVersion: restartedDiscovery.capabilities.schemaVersion, restarted: true },
    project: { workspaceId, projectId: binding.projectId, restoredAfterCoreRestart: true, restoredFromPiSession: true, restoredFromRecentState: false, globalStateAbsent: true },
    commands: commands.filter((name) => name.startsWith("research-")),
    package: { filename: packed.metadata.filename, sha256: sha256(readFileSync(packed.tarball)), entries: packed.metadata.entryCount, statusCommandHandled: installed },
    assertions: { autoStart: true, attach: true, doctor: true, tokenExcludedFromSession: true, globalRecentStateAbsent: true, noModelCall: true, packageOnlyInstall: true },
    elapsedMs: Date.now() - started,
    recordedAt: new Date().toISOString(),
  };
  writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  for (const child of liveRpcChildren) child.kill("SIGTERM");
  if (!activeCorePid && existsSync(join(coreDataDir, "core-service.json"))) {
    try { activeCorePid = JSON.parse(readFileSync(join(coreDataDir, "core-service.json"), "utf8")).pid; } catch {}
  }
  if (activeCorePid) await stopCore(activeCorePid, coreDataDir).catch(() => {});
  rmSync(validationRoot, { recursive: true, force: true });
}

function coreFlags(values) {
  return [
    "--research-core-data-dir", values.coreDataDir,
    "--research-core-database", values.databasePath,
    "--research-state-file", values.stateFile,
    "--research-workspace", values.workspaceId,
    "--research-core-entry", values.coreEntry,
  ];
}

async function verifyPackedInstall(packed, consumer, values) {
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "rexplore-c1-consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", packed.tarball], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 180_000,
    env: cleanNetworkEnv,
  });
  const binary = process.platform === "win32" ? join(consumer, "node_modules/.bin/rexplore.cmd") : join(consumer, "node_modules/.bin/rexplore");
  const rpc = startRpc(binary, consumer, [
    "--no-session",
    "--research-core-data-dir", values.coreDataDir,
    "--research-core-database", values.databasePath,
    "--research-state-file", values.stateFile,
    "--research-workspace", values.workspaceId,
    "--research-no-core-autostart",
  ]);
  try {
    const response = await rpc.request("prompt", { message: "/research-status" });
    return response.data?.disposition === "handled";
  } finally {
    await rpc.close();
  }
}

function packProject(packRoot) {
  mkdirSync(packRoot, { recursive: true });
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packRoot], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const metadata = JSON.parse(output.slice(output.indexOf("[")))[0];
  return { metadata, tarball: join(packRoot, metadata.filename) };
}

async function queryStatus(discovery, workspace, projectId) {
  const token = readFileSync(discovery.tokenFile, "utf8").trim();
  const response = await fetch(`${discovery.baseUrl}/v1/queries`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "1.0.0", queryId: `validation-${Date.now()}`, type: "project.status", workspaceId: workspace, projectId, actor: { id: "user:c1-validation", kind: "user" } }),
  });
  assert(response.ok, `Core status query failed with HTTP ${response.status}`);
  const result = await response.json();
  assert(result.status === "ok", `Core status query was rejected: ${result.error?.message ?? "unknown"}`);
  return result.data;
}

async function waitForDiscovery(dataDir) {
  const path = join(dataDir, "core-service.json");
  await waitFor(() => existsSync(path), 15_000, "Core discovery was not created");
  return JSON.parse(readFileSync(path, "utf8"));
}

async function stopCore(pid, dataDir) {
  if (typeof pid !== "number") return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await waitFor(() => !existsSync(join(dataDir, "core-service.json")), 10_000, "Core discovery was not removed on shutdown");
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(message);
}

function startRpc(binary, cwd, extraArgs = []) {
  const args = ["--mode", "rpc", "--offline", ...extraArgs];
  const child = binary.endsWith(".js") ? spawn(process.execPath, [binary, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] }) : spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  liveRpcChildren.add(child);
  let sequence = 0;
  let stdout = "";
  let stderr = "";
  let closed = false;
  const pending = new Map();
  const events = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type !== "response") events.push(message);
      if (message.type !== "response" || !message.id || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.success) waiter.resolve(message);
      else waiter.reject(new Error(`Pi RPC ${message.command} failed: ${message.error ?? "unknown error"}`));
    }
  });
  child.once("error", rejectAll);
  child.once("exit", (code, signal) => {
    closed = true;
    liveRpcChildren.delete(child);
    if (pending.size) rejectAll(new Error(`Pi RPC exited (${code ?? signal}): ${stderr.trim()}`));
  });
  return {
    events: () => events.slice(-50),
    request(type, body = {}) {
      assert(!closed, `Cannot send ${type}: Pi RPC is closed`);
      const id = `c1-${++sequence}-${type}`;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Pi RPC ${type} timed out: ${stderr.trim()}`));
        }, 30_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, type, ...body })}\n`);
      });
    },
    close() {
      if (closed) return Promise.resolve();
      return new Promise((resolveClose) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => { clearTimeout(timer); resolveClose(); });
        child.stdin.end();
      });
    },
  };
  function rejectAll(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }
}

function writeSessionFixture(path, cwd) {
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id: "c1-validation", timestamp, cwd },
    { type: "message", id: "c1seed01", parentId: null, timestamp, message: { role: "user", content: "C1 persistence fixture; no model invocation.", timestamp: Date.now() } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function latestBinding(entries = []) {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === "research-explorer.context").at(-1)?.data ?? null;
}
function commandNames(response) {
  return (response.data?.commands ?? []).map((command) => command.name);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value);
  renameSync(temporary, path);
}
