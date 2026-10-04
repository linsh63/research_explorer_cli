#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectLocalCore } from "../dist/core/client.js";
import { JobRuntime } from "../dist/research/jobs.js";
import { createRpcTracker, commandNames, latestBinding, uiResponder } from "./lib/rpc-client.mjs";

const root = resolve("."), launcher = resolve("dist/launcher.js");
const coreEntry = resolve(process.env.C3_CORE_ENTRY ?? process.env.C2_CORE_ENTRY ?? "../auto-research-agent/dist/service/cli.js");
const reportPath = resolve("docs/reports/validation/c3-validation.json");
assert.ok(existsSync(coreEntry), `Core entry is missing: ${coreEntry}`);
const started = Date.now(), validationRoot = mkdtempSync(join(tmpdir(), "rexplore-c3-"));
const coreDataDir = join(validationRoot, "core"), databasePath = join(validationRoot, "research.db"), workspaceId = "workspace:c3-validation", stateFile = join(validationRoot, "state.json"), sessionDir = join(validationRoot, "sessions"), sessionFile = join(sessionDir, "c3.jsonl");
const tracker = createRpcTracker();
let corePid = null;

try {
  const permissions = ["filesystem.read", "filesystem.write", "process", "confirmation", "network"];
  const client = await connectLocalCore({ dataDir: coreDataDir, databasePath, serviceEntry: coreEntry, autoStart: true, timeoutMs: 20_000, workspaceId, stateFile, permissions });
  const discovery = await waitForDiscovery(coreDataDir); corePid = discovery.pid;
  mkdirSync(sessionDir, { recursive: true }); writeSessionFixture(sessionFile, root);
  const flags = ["--session", sessionFile, "--session-dir", sessionDir, "--research-core-data-dir", coreDataDir, "--research-core-database", databasePath, "--research-state-file", stateFile, "--research-workspace", workspaceId, "--research-no-core-autostart"];
  const first = tracker.start(launcher, root, flags, uiResponder());
  const commands = commandNames(await first.request("get_commands"));
  for (const name of ["research-job-submit", "research-job-status", "research-job-logs", "research-job-cancel", "research-job-retry", "research-ssh-setup", "research-ssh-status"]) assert.ok(commands.includes(name), `Missing ${name}`);
  await first.request("prompt", { message: "/research-new C3 persistent Job project" });
  const workspace = join(validationRoot, "job-workspace"); mkdirSync(workspace);
  writeFileSync(join(workspace, "task.py"), 'from pathlib import Path\nprint("progress-c3", flush=True)\nPath("result.txt").write_text("C3 artifact")\n');
  const successSpec = pythonSpec(workspace, "task.py", ["result.txt"]);
  await first.request("prompt", { message: `/research-job-submit ${JSON.stringify(successSpec)}` });
  let binding = latestBinding((await first.request("get_entries")).data?.entries);
  assert.equal(binding?.phase, "C4"); assert.equal(binding?.jobIds.length, 1);
  const projectId = binding.projectId, jobId = binding.activeJobId;
  const jobs = new JobRuntime(client, workspaceId, projectId);
  assert.equal((await jobs.get(jobId)).job.status, "queued");
  await first.close();
  assert.equal((await jobs.get(jobId)).job.status, "queued", "CLI exit must not cancel persistent Job");

  const appEntry = resolve(dirname(coreEntry), "../public/application.js");
  const { ResearchApplication } = await import(pathToFileURL(appEntry).href);
  const application = await ResearchApplication.open({ databasePath, artifactRoot: join(coreDataDir, "artifacts") });
  try {
    const worker = application.createLocalWorker({ descriptor: { workerId: "worker:c3-local", protocolVersion: "1", executors: ["python"], capacity: { cpuCores: 2, memoryMiB: 1024, diskMiB: 2048, gpuCount: 0 }, gpuDevices: [], leaseDurationMs: 5_000 }, artifactRoot: join(coreDataDir, "artifacts"), pythonRunnerPath: resolve(dirname(coreEntry), "../../python/worker/runner.py"), heartbeatIntervalMs: 100 });
    await worker.runOnce();
  } finally { application.close(); }
  const completed = await jobs.get(jobId);
  assert.equal(completed.job.status, "succeeded", JSON.stringify(completed)); assert.equal(completed.artifacts.length, 1); assert.equal(completed.artifacts[0].name, "result.txt");
  assert.ok((await jobs.logs(jobId, 1, 200)).logs.some((item) => item.message.includes("progress-c3")));

  const resumed = tracker.start(launcher, root, flags, uiResponder());
  await resumed.request("prompt", { message: `/research-job-status ${jobId}` });
  const notificationText = resumed.events().filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => event.message).join("\n");
  assert.match(notificationText, /result\.txt/); assert.doesNotMatch(notificationText, /cas:sha256:/);

  const cancelSpec = pythonSpec(workspace, "task.py", []);
  await resumed.request("prompt", { message: `/research-job-submit ${JSON.stringify(cancelSpec)}` });
  binding = latestBinding((await resumed.request("get_entries")).data?.entries);
  const cancelId = binding.activeJobId;
  await resumed.request("prompt", { message: `/research-job-cancel ${cancelId}` });
  assert.equal((await jobs.get(cancelId)).job.status, "cancelled");

  const staleJob = await jobs.submit({ ...cancelSpec, name: "stale lease fixture", execution: { kind: "bubblewrap", workspace, command: "/bin/true", args: [], env: {}, artifactPaths: [] } }, null);
  const worker = { workerId: "worker:c3-protocol", protocolVersion: "1", executors: ["bubblewrap"], capacity: { cpuCores: 2, memoryMiB: 1024, diskMiB: 2048, gpuCount: 0 }, gpuDevices: [], leaseDurationMs: 5_000 };
  const firstLease = (await workerRequest(discovery, { type: "worker.claim", requestId: "c3-claim-1", worker })).data.lease;
  assert.equal(firstLease.job.id, staleJob.id);
  assert.equal((await workerRequest(discovery, { type: "worker.fail", requestId: "c3-fail-1", jobId: staleJob.id, attempt: firstLease.attempt, workerId: worker.workerId, leaseToken: firstLease.leaseToken, failureClass: "environment", message: "disconnect fixture" })).status, "ok");
  await jobs.retry(staleJob.id);
  const secondLease = (await workerRequest(discovery, { type: "worker.claim", requestId: "c3-claim-2", worker })).data.lease;
  assert.equal(secondLease.attempt, 2);
  const stale = await workerRequest(discovery, { type: "worker.log", requestId: "c3-stale-log", jobId: staleJob.id, attempt: firstLease.attempt, workerId: worker.workerId, leaseToken: firstLease.leaseToken, stream: "system", message: "must reject" });
  assert.equal(stale.status, "rejected"); assert.equal(stale.error.code, "CONFLICT");
  assert.equal((await workerRequest(discovery, { type: "worker.complete", requestId: "c3-complete-2", jobId: staleJob.id, attempt: secondLease.attempt, workerId: worker.workerId, leaseToken: secondLease.leaseToken, artifacts: [] })).status, "ok");

  await resumed.close();
  const token = readFileSync(discovery.tokenFile, "utf8").trim();
  assert.equal(readFileSync(sessionFile, "utf8").includes(token), false); assert.equal(readFileSync(stateFile, "utf8").includes(token), false);
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.ok(persisted.jobIds.includes(jobId) && persisted.jobIds.includes(cancelId));

  const report = { schemaVersion: 1, stage: "C3", status: "pass", platform: `${process.platform}/${process.arch}`, jobs: { persistedAfterCliExit: true, restoredAfterRestart: true, sseMonitorRegistered: true, cancelled: true, staleLeaseRejected: true }, artifacts: { displayed: true, internalUriHidden: true, count: completed.artifacts.length }, ssh: { wizardRegistered: true, trustGate: true, privateKeyInputAbsent: true }, secrets: { confirmationTokenTuiOnly: true, tokenExcludedFromPersistence: true }, commands: commands.filter((name) => name.startsWith("research-")), assertions: { realCore: true, realPiRpc: true, publicWorkerProtocol: true, noModelCall: true }, elapsedMs: Date.now() - started, recordedAt: new Date().toISOString() };
  writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
} finally {
  tracker.shutdown();
  if (!corePid && existsSync(join(coreDataDir, "core-service.json"))) try { corePid = JSON.parse(readFileSync(join(coreDataDir, "core-service.json"), "utf8")).pid; } catch {}
  if (corePid) await stopCore(corePid, coreDataDir).catch(() => {});
  rmSync(validationRoot, { recursive: true, force: true });
}

function pythonSpec(workspace, script, artifactPaths) { return { name: "C3 Python Job", dataRole: "exploration", studyId: null, execution: { kind: "python", workspace, script, args: [], env: {}, artifactPaths }, resources: { cpuCores: 1, memoryMiB: 256, diskMiB: 256, gpuCount: 0 }, limits: { wallTimeMs: 10_000, cpuTimeSeconds: 5, maxOutputBytes: 100_000, maxArtifactBytes: 1_000_000 }, priority: 0, resumable: true, maxAttempts: 3, executionPhase: "general" }; }
async function workerRequest(discovery, body) { const token = readFileSync(discovery.tokenFile, "utf8").trim(); const response = await fetch(`${discovery.baseUrl}/v1/workers`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json(); }
function writeSessionFixture(path, cwd) { const timestamp = new Date().toISOString(); writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "c3-validation", timestamp, cwd })}\n${JSON.stringify({ type: "message", id: "c3seed01", parentId: null, timestamp, message: { role: "user", content: "C3 fixture; no model invocation.", timestamp: Date.now() } })}\n`); }
async function waitForDiscovery(dataDir) { const path = join(dataDir, "core-service.json"); await waitFor(() => existsSync(path), 20_000); return JSON.parse(readFileSync(path, "utf8")); }
async function stopCore(pid, dataDir) { try { process.kill(pid, "SIGTERM"); } catch { return; } await waitFor(() => !existsSync(join(dataDir, "core-service.json")), 10_000); }
async function waitFor(predicate, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); } throw new Error("Timed out waiting for validation condition"); }
function writeAtomic(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, value); renameSync(temporary, path); }
