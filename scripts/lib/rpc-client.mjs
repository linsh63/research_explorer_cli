import { spawn } from "node:child_process";

export function createRpcTracker() {
  const children = new Set();
  return {
    start(binary, cwd, extraArgs = [], respondUi = () => null) {
      const args = ["--mode", "rpc", "--offline", ...extraArgs];
      const child = binary.endsWith(".js") ? spawn(process.execPath, [binary, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] }) : spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      let sequence = 0, stdout = "", stderr = "", closed = false;
      const pending = new Map(), events = [];
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
      child.once("exit", (code, signal) => { closed = true; children.delete(child); if (pending.size) rejectAll(new Error(`RPC exited (${code ?? signal}): ${stderr}`)); });
      return {
        events: () => events.slice(),
        request(type, body = {}) {
          if (closed) throw new Error(`RPC closed before ${type}`);
          const id = `validation-${++sequence}-${type}`;
          return new Promise((resolveRequest, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr}`)); }, 45_000);
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
    },
    shutdown() { for (const child of children) child.kill("SIGTERM"); children.clear(); },
  };
}

export function uiResponder(options = {}) {
  return (message) => {
    if (message.method === "confirm") return { confirmed: options.confirm ?? true };
    if (message.method === "select") return { value: options.select?.(message.options) ?? message.options?.[0] };
    if (message.method === "input") return options.input ? { value: options.input(message) } : { cancelled: true };
    if (message.method === "editor") return options.editor ? { value: options.editor(message) } : { cancelled: true };
    return null;
  };
}

export function commandNames(response) { return (response.data?.commands ?? []).map((command) => command.name); }
export function latestBinding(entries = []) { return entries.filter((entry) => entry.type === "custom" && entry.customType === "research-explorer.context").at(-1)?.data ?? null; }
