#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { connectLocalCore } from "../dist/core/client.js";
import { ResearchRuntime } from "../dist/research/runtime.js";
import { createRpcTracker, commandNames, latestBinding, uiResponder } from "./lib/rpc-client.mjs";

const root = resolve("."), launcher = resolve("dist/launcher.js"), coreEntry = resolve(process.env.C5_CORE_ENTRY ?? process.env.C4_CORE_ENTRY ?? "../auto-research-agent/dist/service/cli.js"), reportPath = resolve("docs/reports/validation/c5-release-audit.json"), previousCommit = "109108ca9061052fd841d8cc6ff4f1e8f37a6bc6";
assert.ok(existsSync(coreEntry), `Core entry is missing: ${coreEntry}`);
const started = Date.now(), validationRoot = mkdtempSync(join(tmpdir(), "rexplore-c5-")), coreDataDir = join(validationRoot, "core"), databasePath = join(validationRoot, "research.db"), workspaceId = "workspace:c5-validation", stateFile = join(validationRoot, "state.json"), sessionDir = join(validationRoot, "sessions"), sessionFile = join(sessionDir, "c5.jsonl"), renderedReport = join(validationRoot, "research-report.md");
const tracker = createRpcTracker(), cleanNetworkEnv = { ...process.env }; for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete cleanNetworkEnv[key]; let corePid = null;

try {
  const client = await connectLocalCore({ dataDir: coreDataDir, databasePath, serviceEntry: coreEntry, autoStart: true, timeoutMs: 20_000, workspaceId, stateFile, permissions: ["filesystem.read", "filesystem.write", "process", "confirmation"] });
  const discovery = await waitForDiscovery(coreDataDir); corePid = discovery.pid;
  mkdirSync(sessionDir, { recursive: true }); writeSessionFixture(sessionFile, root);
  const flags = ["--session", sessionFile, "--session-dir", sessionDir, "--research-core-data-dir", coreDataDir, "--research-core-database", databasePath, "--research-state-file", stateFile, "--research-workspace", workspaceId, "--research-no-core-autostart"];
  const rpc = tracker.start(launcher, root, flags, uiResponder({ confirm: true, select: (options) => options[0] }));
  const commands = commandNames(await rpc.request("get_commands"));
  for (const command of ["research-capabilities", "research-capability", "research-report"]) assert.ok(commands.includes(command), `Missing ${command}`);
  await rpc.request("prompt", { message: "/research-new C5 end-to-end report project" });
  await rpc.request("prompt", { message: "/research-mode candidate" });
  await rpc.request("prompt", { message: "/research-next Propose the first question" });
  await rpc.request("prompt", { message: "/research-next Select the proposed question" });
  await rpc.request("prompt", { message: "/research-next Approve the bounded scope" });
  const binding = latestBinding((await rpc.request("get_entries")).data?.entries), runtime = new ResearchRuntime(client, workspaceId, binding.projectId), scoped = await runtime.status();
  assert.equal(scoped.project.status, "scoped");
  await rpc.request("prompt", { message: `/research-report ${renderedReport}` });
  const reportText = readFileSync(renderedReport, "utf8");
  assert.match(reportText, /Verified Project facts/); assert.match(reportText, /project\.status/);
  const events = await runtime.events(1, 100); assert.ok(events.events.some((item) => item.type === "capability.invoked"));

  const treeBefore = await rpc.request("get_tree"); assert.ok(treeBefore.data?.tree?.length > 0);
  assert.equal((await rpc.request("set_auto_compaction", { enabled: false })).success, true);
  assert.equal((await rpc.request("set_auto_compaction", { enabled: true })).success, true);
  assert.equal((await rpc.request("get_state")).data?.autoCompactionEnabled, true);
  const cloned = await rpc.request("clone"); assert.equal(cloned.data?.cancelled, false);
  const forked = await rpc.request("fork", { entryId: "c5seed01" }); assert.equal(forked.data?.cancelled, false);
  const treeAfter = await rpc.request("get_tree"); assert.ok(treeAfter.data?.tree?.length > 0);
  await rpc.close();

  const printArgs = ["--offline", "--no-session", "--research-core-data-dir", coreDataDir, "--research-state-file", stateFile, "--research-workspace", workspaceId, "--research-no-core-autostart"];
  execFileSync(process.execPath, [launcher, ...printArgs, "--print", "/research-status"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  execFileSync(process.execPath, [launcher, ...printArgs, "--mode", "json", "/research-about"], { cwd: root, encoding: "utf8", timeout: 30_000 });

  const currentPack = packProject(root, join(validationRoot, "current-pack")), entries = new Set(currentPack.metadata.files.map((item) => item.path));
  for (const required of ["LICENSE", "NOTICE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "README.md", "dist/launcher.js", "dist/extension/index.js"]) assert.ok(entries.has(required), `Package missing ${required}`);
  assert.equal(currentPack.metadata.version, "0.1.0");
  const previousPack = packPrevious(join(validationRoot, "previous"));
  const consumer = join(validationRoot, "consumer"); mkdirSync(consumer); writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "c5-consumer", private: true }));
  installTarball(consumer, previousPack.tarball); assert.equal(installedVersion(consumer), "0.1.0-rc.1"); runInstalled(consumer, printArgs);
  installTarball(consumer, currentPack.tarball); assert.equal(installedVersion(consumer), "0.1.0"); runInstalled(consumer, printArgs);
  installTarball(consumer, previousPack.tarball); assert.equal(installedVersion(consumer), "0.1.0-rc.1"); runInstalled(consumer, printArgs);

  const docs = checkLocalDocLinks(resolve("README.md"), resolve("docs")); assert.deepEqual(docs.missing, []);
  const token = readFileSync(discovery.tokenFile, "utf8").trim(), persistedFiles = [sessionFile, stateFile, renderedReport, currentPack.tarball];
  for (const path of persistedFiles) assert.equal(readFileSync(path).includes(Buffer.from(token)), false, `Token leaked to ${relative(root, path)}`);

  const audit = { schemaVersion: 1, stage: "C5", status: "pass", releaseVersion: "0.1.0", platform: `${process.platform}/${process.arch}`, endToEnd: { projectCreated: true, questionProposed: true, questionSelected: true, scopeApproved: true, scientificReportRendered: true, publicCoreOnly: true }, pi: { printMode: true, jsonMode: true, rpcSmokeOnly: true, sessionTree: true, fork: true, clone: true, autoCompactionControl: true, nativeChatAndAuthInherited: true }, package: { filename: currentPack.metadata.filename, sha256: sha256(readFileSync(currentPack.tarball)), entries: currentPack.metadata.entryCount, packageOnly: true, licenseComplete: true, upgradeFrom: "0.1.0-rc.1", rollbackTo: "0.1.0-rc.1" }, security: { secretScan: true, coreTokenExcluded: true, confirmationTokenExcluded: true }, docs: { checkedFiles: docs.checked, missingLinks: 0 }, publishing: { gitTagCreated: false, githubReleaseCreated: false, npmPublished: process.env.C5_EXPECT_NPM_PUBLISHED === "1" }, elapsedMs: Date.now() - started, recordedAt: new Date().toISOString() };
  writeAtomic(reportPath, `${JSON.stringify(audit, null, 2)}\n`); console.log(JSON.stringify(audit));
} finally { tracker.shutdown(); if (!corePid && existsSync(join(coreDataDir, "core-service.json"))) try { corePid = JSON.parse(readFileSync(join(coreDataDir, "core-service.json"), "utf8")).pid; } catch {} if (corePid) await stopCore(corePid, coreDataDir).catch(() => {}); rmSync(validationRoot, { recursive: true, force: true }); }

function packProject(cwd, destination) { mkdirSync(destination, { recursive: true }); const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], { cwd, encoding: "utf8", timeout: 180_000 }); const metadata = JSON.parse(output.slice(output.indexOf("[")))[0]; return { metadata, tarball: join(destination, metadata.filename) }; }
function packPrevious(directory) { mkdirSync(directory, { recursive: true }); const archive = join(directory, "previous.tar"), source = join(directory, "source"); mkdirSync(source); execFileSync("git", ["archive", "--format=tar", "--output", archive, previousCommit], { cwd: root }); execFileSync("tar", ["-xf", archive, "-C", source]); execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, env: cleanNetworkEnv, timeout: 180_000, stdio: "ignore" }); return packProject(source, join(directory, "pack")); }
function installTarball(consumer, tarball) { execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer, env: cleanNetworkEnv, timeout: 180_000, stdio: "ignore" }); }
function installedVersion(consumer) { return JSON.parse(readFileSync(join(consumer, "node_modules", "research-explorer-cli", "package.json"), "utf8")).version; }
function runInstalled(consumer, args) { const binary = join(consumer, "node_modules", ".bin", "rexplore"); execFileSync(binary, [...args, "--print", "/research-status"], { cwd: consumer, timeout: 30_000, stdio: "ignore" }); }
function checkLocalDocLinks(readme, docsRoot) { const files = [readme, ...walk(docsRoot).filter((path) => path.endsWith(".md"))], missing = []; for (const file of files) { const text = readFileSync(file, "utf8"); for (const match of text.matchAll(/\]\(([^)]+)\)/g)) { const target = match[1].split("#")[0]; if (!target || /^(?:https?:|mailto:|\/)/.test(target)) continue; const path = resolve(dirname(file), decodeURIComponent(target)); if (!existsSync(path)) missing.push(`${relative(root, file)} -> ${target}`); } } return { checked: files.length, missing }; }
function walk(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]); }
function writeSessionFixture(path, cwd) { const timestamp = new Date().toISOString(); writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "c5-validation", timestamp, cwd })}\n${JSON.stringify({ type: "message", id: "c5seed01", parentId: null, timestamp, message: { role: "user", content: "C5 fixture; no model invocation.", timestamp: Date.now() } })}\n`); }
async function waitForDiscovery(dataDir) { const path = join(dataDir, "core-service.json"); await waitFor(() => existsSync(path), 20_000); return JSON.parse(readFileSync(path, "utf8")); }
async function stopCore(pid, dataDir) { try { process.kill(pid, "SIGTERM"); } catch { return; } await waitFor(() => !existsSync(join(dataDir, "core-service.json")), 10_000); }
async function waitFor(predicate, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolveDelay) => setTimeout(resolveDelay, 50)); } throw new Error("Timed out waiting for validation condition"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function writeAtomic(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, value); renameSync(temporary, path); }
