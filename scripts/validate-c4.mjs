#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connectLocalCore } from "../dist/core/client.js";
import { PluginRuntime } from "../dist/research/plugins.js";
import { ProjectRuntime } from "../dist/research/projects.js";
import { SshRuntime } from "../dist/research/ssh.js";
import { createRpcTracker, commandNames, latestBinding, uiResponder } from "./lib/rpc-client.mjs";

const root = resolve("."), launcher = resolve("dist/launcher.js"), coreEntry = resolve(process.env.C4_CORE_ENTRY ?? process.env.C3_CORE_ENTRY ?? "../auto-research-agent/dist/service/cli.js"), reportPath = resolve("docs/reports/validation/c4-validation.json");
assert.ok(existsSync(coreEntry), `Core entry is missing: ${coreEntry}`);
const started = Date.now(), validationRoot = mkdtempSync(join(tmpdir(), "rexplore-c4-")), coreDataDir = join(validationRoot, "core"), databasePath = join(validationRoot, "research.db"), workspaceId = "workspace:c4-validation", stateFile = join(validationRoot, "state.json"), sessionDir = join(validationRoot, "sessions"), sessionFile = join(sessionDir, "c4.jsonl"), pluginRoot = join(validationRoot, "plugin"), marker = join(validationRoot, "PLUGIN_EXECUTED"), bundlePath = join(validationRoot, "project.bundle.json");
const tracker = createRpcTracker(); const corePids = [];

try {
  const permissions = ["filesystem.read", "filesystem.write", "process", "confirmation"];
  const client = await connectLocalCore({ dataDir: coreDataDir, databasePath, serviceEntry: coreEntry, autoStart: true, timeoutMs: 20_000, workspaceId, stateFile, permissions });
  const discovery = await waitForDiscovery(coreDataDir); corePids.push({ pid: discovery.pid, dataDir: coreDataDir });
  mkdirSync(sessionDir, { recursive: true }); writeSessionFixture(sessionFile, root); writePlugin(pluginRoot, "1.0.0", ["filesystem.read"], marker);
  const confirmations = [];
  const responder = uiResponder({ confirm: true });
  const rpc = tracker.start(launcher, root, ["--session", sessionFile, "--session-dir", sessionDir, "--research-core-data-dir", coreDataDir, "--research-core-database", databasePath, "--research-state-file", stateFile, "--research-workspace", workspaceId, "--research-no-core-autostart"], (message) => { if (message.method === "confirm") confirmations.push({ title: message.title, message: message.message }); return responder(message); });
  const commands = commandNames(await rpc.request("get_commands"));
  for (const name of ["research-plugin-search", "research-plugin-inspect", "research-plugin-install", "research-plugin-enable", "research-plugin-disable", "research-plugin-update", "research-plugin-remove", "research-fork", "research-bundle-export", "research-bundle-import", "research-dependencies"]) assert.ok(commands.includes(name), `Missing ${name}`);
  await rpc.request("prompt", { message: "/research-new C4 plugin and Bundle project" });
  let binding = latestBinding((await rpc.request("get_entries")).data?.entries), projectId = binding.projectId;
  const plugins = new PluginRuntime(client, workspaceId, projectId);
  await rpc.request("prompt", { message: `/research-plugin-source-add local ${pluginRoot} C4-fixture` });
  const descriptors = await plugins.search("@fixture/c4-plugin"); assert.equal(descriptors.length, 1); const descriptor = descriptors[0];
  assert.equal(existsSync(marker), false, "catalog browsing must not execute plugin code");
  await rpc.request("prompt", { message: `/research-plugin-search c4-plugin` });
  await rpc.request("prompt", { message: `/research-plugin-inspect ${descriptor.descriptorId}` });
  await rpc.request("prompt", { message: `/research-plugin-install ${descriptor.descriptorId} project` });
  let installation = (await plugins.installations()).find((item) => item.pluginId === descriptor.pluginId); assert.ok(installation); assert.equal(installation.status, "installed"); assert.equal(existsSync(marker), false);
  await rpc.request("prompt", { message: `/research-plugin-enable ${installation.id}` });
  installation = await plugins.findInstallation(installation.id); assert.equal(installation.status, "enabled");

  writePlugin(pluginRoot, "1.1.0", ["filesystem.read", "network"], marker);
  const sources = await rawQuery(client, workspaceId, null, "plugin.sources", {}), sourceId = sources.sources[0].id;
  await rpc.request("prompt", { message: `/research-plugin-source-refresh ${sourceId}` });
  const target = (await plugins.search("@fixture/c4-plugin")).find((item) => item.version === "1.1.0"); assert.ok(target);
  await rpc.request("prompt", { message: `/research-plugin-update ${installation.id} ${target.descriptorId}` });
  installation = await plugins.findInstallation(installation.id); assert.equal(installation.version, "1.1.0"); assert.ok(installation.approvedPermissions.includes("network"));
  assert.ok(confirmations.some((item) => item.title === "Approve expanded plugin permissions?" && item.message.includes("network")));
  await rpc.request("prompt", { message: `/research-plugin-enable ${installation.id}` });
  assert.equal(existsSync(marker), false, "plugin lifecycle must not import extension code during catalog management");

  await rpc.request("prompt", { message: `/research-bundle-export ${bundlePath} embed` });
  const bundleText = readFileSync(bundlePath, "utf8"), bundle = JSON.parse(bundleText);
  assert.equal(bundle.bundleVersion, "2"); assert.ok(bundle.pluginLocks.some((item) => item.pluginId === descriptor.pluginId));
  assert.doesNotMatch(bundleText, /PLUGIN_EXECUTED|-----BEGIN .*PRIVATE KEY|sk-[A-Za-z0-9]{16}/);
  await rpc.request("prompt", { message: "/research-fork c4-branch Preserve an auditable alternative research branch" });
  const forkBinding = latestBinding((await rpc.request("get_entries")).data?.entries); assert.notEqual(forkBinding.projectId, projectId);
  await rpc.close();

  const targetDataDir = join(validationRoot, "target-core"), targetDatabase = join(validationRoot, "target.db"), targetState = join(validationRoot, "target-state.json"), targetSessionDir = join(validationRoot, "target-sessions"), targetSession = join(targetSessionDir, "c4-target.jsonl"), targetWorkspace = "workspace:c4-target";
  const targetClient = await connectLocalCore({ dataDir: targetDataDir, databasePath: targetDatabase, serviceEntry: coreEntry, autoStart: true, timeoutMs: 20_000, workspaceId: targetWorkspace, stateFile: targetState, permissions });
  const targetDiscovery = await waitForDiscovery(targetDataDir); corePids.push({ pid: targetDiscovery.pid, dataDir: targetDataDir });
  mkdirSync(targetSessionDir, { recursive: true }); writeSessionFixture(targetSession, root);
  const targetRpc = tracker.start(launcher, root, ["--session", targetSession, "--session-dir", targetSessionDir, "--research-core-data-dir", targetDataDir, "--research-core-database", targetDatabase, "--research-state-file", targetState, "--research-workspace", targetWorkspace, "--research-no-core-autostart"], responder);
  await targetRpc.request("prompt", { message: "/research-new C4 import target bootstrap" });
  await targetRpc.request("prompt", { message: `/research-bundle-import ${bundlePath}` });
  binding = latestBinding((await targetRpc.request("get_entries")).data?.entries); assert.equal(binding.projectId, projectId); assert.notEqual(binding.projectId, forkBinding.projectId);
  const importedRuntime = new ProjectRuntime(targetClient, targetWorkspace, binding.projectId), dependencies = await importedRuntime.dependencies();
  assert.ok(dependencies.plugins.some((item) => item.pluginId === descriptor.pluginId));
  assert.ok(dependencies.plugins.some((item) => item.status === "missing" || item.status === "incompatible"), "import must expose missing Project-scoped plugin dependency");
  assert.equal((await new SshRuntime(targetClient, targetWorkspace, binding.projectId).project()).requirements.length, 0, "import must not restore SSH environment bindings");
  await targetRpc.request("prompt", { message: "/research-dependencies" });
  const notices = [...rpc.events(), ...targetRpc.events()].filter((item) => item.type === "extension_ui_request" && item.method === "notify").map((item) => item.message).join("\n");
  assert.match(notices, /Pi UI (?:extensions\/packages|package state)/); assert.match(notices, /missing|incompatible/);
  await targetRpc.close();

  const token = readFileSync(discovery.tokenFile, "utf8").trim(); assert.equal(readFileSync(sessionFile, "utf8").includes(token), false); assert.equal(bundleText.includes(token), false);
  const report = { schemaVersion: 1, stage: "C4", status: "pass", platform: `${process.platform}/${process.arch}`, plugins: { staticBrowseNoExecution: true, inspected: true, installed: true, enabled: true, permissionExpansionConfirmed: true, coreVsPiDistinguished: true }, projects: { forked: true, bundleV2Exported: true, bundleImported: true, missingDependencyVisible: true }, isolation: { sshNotRestored: true, bearerNotBundled: true, privateKeyNotBundled: true }, commands: commands.filter((name) => name.startsWith("research-")), assertions: { realCore: true, realPiRpc: true, noModelCall: true }, elapsedMs: Date.now() - started, recordedAt: new Date().toISOString() };
  writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
} finally { tracker.shutdown(); for (const item of corePids) await stopCore(item.pid, item.dataDir).catch(() => {}); rmSync(validationRoot, { recursive: true, force: true }); }

function writePlugin(path, version, permissions, markerPath) { mkdirSync(join(path, "extensions"), { recursive: true }); mkdirSync(join(path, "skills", "fixture"), { recursive: true }); writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@fixture/c4-plugin", version, description: "C4 static plugin fixture", license: "MIT", maintainers: ["C4 fixture"], pi: { extensions: ["extensions/index.ts"], skills: ["skills/fixture"] }, autoResearch: { domain: ["vision"], permissions, sideEffects: ["writes project artifacts"], tools: ["c4_tool"], apps: [], mcp: [], scenarios: [], coreSchemaRange: "^1.0.0", piVersionRange: "^0.85.0" } }, null, 2)); writeFileSync(join(path, "extensions", "index.ts"), `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(markerPath)},"EXECUTED");\n`); writeFileSync(join(path, "skills", "fixture", "SKILL.md"), "# C4 fixture\nStatic metadata only.\n"); }
async function rawQuery(client, workspaceId, projectId, type, payload) { const result = await client.query({ schemaVersion: "1.0.0", queryId: `c4-${crypto.randomUUID()}`, type, workspaceId, projectId, actor: { id: "user:c4", kind: "user" }, ...payload }); assert.equal(result.status, "ok"); return result.data; }
function writeSessionFixture(path, cwd) { const timestamp = new Date().toISOString(); writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "c4-validation", timestamp, cwd })}\n${JSON.stringify({ type: "message", id: "c4seed01", parentId: null, timestamp, message: { role: "user", content: "C4 fixture; no model invocation.", timestamp: Date.now() } })}\n`); }
async function waitForDiscovery(dataDir) { const path = join(dataDir, "core-service.json"); await waitFor(() => existsSync(path), 20_000); return JSON.parse(readFileSync(path, "utf8")); }
async function stopCore(pid, dataDir) { try { process.kill(pid, "SIGTERM"); } catch { return; } await waitFor(() => !existsSync(join(dataDir, "core-service.json")), 10_000); }
async function waitFor(predicate, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); } throw new Error("Timed out waiting for validation condition"); }
function writeAtomic(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, value); renameSync(temporary, path); }
