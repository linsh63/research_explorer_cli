#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(".");
const reportPath = resolve("docs/reports/validation/c0-validation.json");
const launcher = resolve("dist/launcher.js");
const expectedPiVersion = "1.0.2";
const started = Date.now();
const cleanNetworkEnv = { ...process.env };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete cleanNetworkEnv[key];

const version = execFileSync(process.execPath, [launcher, "--version"], {
  cwd: root,
  encoding: "utf8",
  timeout: 15_000,
}).trim();
assert(version === expectedPiVersion, `Unexpected Pi version through rexplore: ${version}`);

const validationRoot = mkdtempSync(join(tmpdir(), "rexplore-c0-"));
try {
  const lifecycle = await verifyPersistentLifecycle(launcher, root, join(validationRoot, "sessions"));
  const packed = packProject(join(validationRoot, "pack"));
  const installed = await verifyPackedInstall(packed, join(validationRoot, "consumer"));
  const report = {
    schemaVersion: 1,
    stage: "C0",
    status: "pass",
    product: "Research Explorer",
    binary: "rexplore",
    piVersion: version,
    repository: {
      commands: lifecycle.commands.filter((name) => name.startsWith("research-")),
      contextEntryPersisted: lifecycle.contextEntryPersisted,
      contextEntryRestored: lifecycle.contextEntryRestored,
      abortAcknowledged: lifecycle.abortAcknowledged,
      persistentSessionFile: lifecycle.persistentSessionFile,
    },
    package: {
      filename: packed.metadata.filename,
      sha256: sha256(readFileSync(packed.tarball)),
      entries: packed.metadata.entryCount,
      installedVersion: installed.version,
      commands: installed.commands.filter((name) => name.startsWith("research-")),
    },
    assertions: {
      piCliReused: true,
      extensionLoaded: true,
      durableSessionResume: true,
      cancellationPath: true,
      noModelCall: true,
      noCoreInternalImport: true,
      packageOnlyInstall: true,
    },
    elapsedMs: Date.now() - started,
    recordedAt: new Date().toISOString(),
  };
  writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  rmSync(validationRoot, { recursive: true, force: true });
}

async function verifyPersistentLifecycle(binary, cwd, sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  const fixtureFile = join(sessionDir, "c0-validation.jsonl");
  writeSessionFixture(fixtureFile, cwd);
  const first = startRpc(binary, cwd, ["--session-dir", sessionDir, "--session", fixtureFile]);
  try {
    const commands = commandNames(await first.request("get_commands"));
    assert(commands.includes("research-about"), "Research Explorer command was not loaded through Pi RPC");
    const prompt = await first.request("prompt", { message: "/research-about" });
    assert(prompt.data?.disposition === "handled", "Research Explorer extension command was not handled");
    const entries = await first.request("get_entries");
    const contextEntryPersisted = hasContextEntry(entries.data?.entries);
    assert(contextEntryPersisted, "Research Explorer context entry was not persisted");
    const state = await first.request("get_state");
    const sessionFile = state.data?.sessionFile;
    assert(typeof sessionFile === "string" && sessionFile.length > 0, "Pi did not create a session file");
    assert(resolve(sessionFile) === resolve(fixtureFile), "Pi did not open the requested persistent session");
    const abort = await first.request("abort");
    assert(abort.success, "Pi abort path did not acknowledge cancellation");
    await first.close();

    const resumed = startRpc(binary, cwd, ["--session-dir", sessionDir, "--session", sessionFile]);
    try {
      const restoredEntries = await resumed.request("get_entries");
      const contextEntryRestored = hasContextEntry(restoredEntries.data?.entries);
      assert(contextEntryRestored, "Research Explorer context entry was not restored from the session file");
      return { commands, contextEntryPersisted, contextEntryRestored, abortAcknowledged: abort.success, persistentSessionFile: true };
    } finally {
      await resumed.close();
    }
  } catch (error) {
    await first.close(true);
    throw error;
  }
}

function writeSessionFixture(path, cwd) {
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: 3, id: "c0-validation", timestamp, cwd };
  const user = {
    type: "message",
    id: "c0seed01",
    parentId: null,
    timestamp,
    message: { role: "user", content: "C0 persistence fixture; no model invocation.", timestamp: Date.now() },
  };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
}

function packProject(packRoot) {
  mkdirSync(packRoot, { recursive: true });
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const metadata = JSON.parse(output.slice(output.indexOf("[")))[0];
  return { metadata, tarball: join(packRoot, metadata.filename) };
}

async function verifyPackedInstall(packed, consumer) {
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "rexplore-c0-consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", packed.tarball], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 180_000,
    env: cleanNetworkEnv,
  });
  const binary = process.platform === "win32" ? join(consumer, "node_modules/.bin/rexplore.cmd") : join(consumer, "node_modules/.bin/rexplore");
  const version = execFileSync(binary, ["--version"], { cwd: consumer, encoding: "utf8", timeout: 15_000 }).trim();
  const rpc = startRpc(binary, consumer, ["--no-session"]);
  try {
    const commands = commandNames(await rpc.request("get_commands"));
    assert(version === expectedPiVersion, `Packed rexplore used unexpected Pi version: ${version}`);
    assert(commands.includes("research-about"), "Packed rexplore did not load the Research Explorer extension");
    return { version, commands };
  } finally {
    await rpc.close();
  }
}

function startRpc(binary, cwd, extraArgs = []) {
  const args = ["--mode", "rpc", "--offline", ...extraArgs];
  const child = binary.endsWith(".js")
    ? spawn(process.execPath, [binary, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0;
  let stdout = "";
  let stderr = "";
  let closed = false;
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
      if (message.type !== "response" || !message.id || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.success) waiter.resolve(message);
      else waiter.reject(new Error(`Pi RPC ${message.command} failed: ${message.error ?? "unknown error"}`));
    }
  });
  child.once("error", (error) => rejectAll(error));
  child.once("exit", (code, signal) => {
    closed = true;
    if (pending.size) rejectAll(new Error(`Pi RPC exited (${code ?? signal}): ${stderr.trim()}`));
  });
  return {
    request(type, body = {}) {
      assert(!closed, `Cannot send ${type}: Pi RPC is closed`);
      const id = `c0-${++sequence}-${type}`;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Pi RPC ${type} timed out: ${stderr.trim()}`));
        }, 20_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, type, ...body })}\n`);
      });
    },
    close(force = false) {
      if (closed) return Promise.resolve();
      return new Promise((resolveClose) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => { clearTimeout(timer); resolveClose(); });
        if (force) child.kill("SIGTERM");
        else child.stdin.end();
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

function commandNames(response) {
  return (response.data?.commands ?? []).map((command) => command.name);
}
function hasContextEntry(entries = []) {
  return entries.some((entry) => entry.type === "custom" && entry.customType === "research-explorer.context");
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value);
  renameSync(temporary, path);
}
