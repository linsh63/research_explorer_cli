#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const piLibrary = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(piLibrary), "bundle", "cli.js");
const extension = fileURLToPath(new URL("./extension/index.js", import.meta.url));

if (!existsSync(piCli)) throw new Error(`Pinned Pi CLI entry is missing: ${piCli}`);
if (!existsSync(extension)) throw new Error(`Research Explorer extension is missing: ${extension}`);

const userArgs = process.argv.slice(2);
const startupArgs = userArgs.length === 0 && process.stdin.isTTY && process.stdout.isTTY ? ["--resume"] : userArgs;
const child = spawn(process.execPath, [piCli, "--extension", extension, ...startupArgs], {
  stdio: "inherit",
  env: { ...process.env, RESEARCH_EXPLORER_LAUNCHED_BY: "rexplore" },
  windowsHide: true,
});

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(`rexplore could not start Pi: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
