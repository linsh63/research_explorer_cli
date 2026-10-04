import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CoreConfig,
  CoreConnection,
  CoreHealth,
  CoreResult,
  DoctorReport,
  CoreStreamEvent,
  CoreStreamOptions,
  ServiceCapabilities,
} from "./types.js";
import { CORE_SERVICE_VERSION, PUBLIC_SCHEMA_VERSION } from "./types.js";

interface Discovery {
  baseUrl: string;
  tokenFile?: string | null;
  tokenSecretName?: string;
  pid?: number;
}

export class CoreConnectionError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "authentication" | "compatibility" | "configuration") {
    super(message);
    this.name = "CoreConnectionError";
  }
}

class HttpCoreConnection implements CoreConnection {
  private constructor(
    readonly baseUrl: string,
    private readonly token: string,
    readonly capabilities: ServiceCapabilities,
    private readonly timeoutMs: number,
  ) {}

  static async connect(discovery: Discovery, config: CoreConfig): Promise<HttpCoreConnection> {
    const baseUrl = validateBaseUrl(discovery.baseUrl);
    const token = resolveToken(discovery, config.dataDir);
    const capabilities = await request<ServiceCapabilities>(baseUrl, token, "/v1/capabilities", config.timeoutMs);
    validateCompatibility(capabilities);
    return new HttpCoreConnection(baseUrl, token, capabilities, config.timeoutMs);
  }

  health(): Promise<CoreHealth> {
    return request<CoreHealth>(this.baseUrl, this.token, "/v1/health", this.timeoutMs);
  }

  execute<T = unknown>(command: unknown): Promise<CoreResult<T>> {
    return request<CoreResult<T>>(this.baseUrl, this.token, "/v1/commands", this.timeoutMs, command);
  }

  query<T = unknown>(query: unknown): Promise<CoreResult<T>> {
    return request<CoreResult<T>>(this.baseUrl, this.token, "/v1/queries", this.timeoutMs, query);
  }

  async *stream(options: CoreStreamOptions): AsyncGenerator<CoreStreamEvent> {
    const params = new URLSearchParams({
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      actorId: options.actorId ?? "user:research-explorer",
      fromSequence: String(options.fromSequence ?? 1),
      logFrom: String(options.logFrom ?? 1),
    });
    if (options.jobId) params.set("jobId", options.jobId);
    const response = await openStream(`${this.baseUrl}/v1/stream?${params}`, this.token, this.timeoutMs, options.signal);
    const decoder = new TextDecoder();
    let buffer = "";
    let current = { event: "message", id: null as string | null, data: [] as string[] };
    for await (const chunk of response) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          if (current.data.length) {
            const raw = current.data.join("\n");
            yield { event: current.event, id: current.id, data: JSON.parse(raw) };
          }
          current = { event: "message", id: null, data: [] };
        } else if (line.startsWith("event:")) current.event = line.slice(6).trim();
        else if (line.startsWith("id:")) current.id = line.slice(3).trim();
        else if (line.startsWith("data:")) current.data.push(line.slice(5).trimStart());
      }
    }
  }
}

export async function connectLocalCore(config: CoreConfig): Promise<CoreConnection> {
  const discoveryPath = join(config.dataDir, "core-service.json");
  let firstError: unknown;
  if (existsSync(discoveryPath)) {
    try {
      return await HttpCoreConnection.connect(readDiscovery(discoveryPath), config);
    } catch (error) {
      if (error instanceof CoreConnectionError && error.kind !== "unavailable") throw error;
      firstError = error;
    }
  }
  if (!config.autoStart) throw unavailable(firstError ?? new Error("Core Service discovery file was not found"));
  const entry = resolveServiceEntry(config.serviceEntry);
  await launchCore(entry, config);
  const deadline = Date.now() + config.timeoutMs;
  let lastError: unknown = firstError;
  while (Date.now() < deadline) {
    await delay(75);
    if (!existsSync(discoveryPath)) continue;
    try {
      return await HttpCoreConnection.connect(readDiscovery(discoveryPath), config);
    } catch (error) {
      if (error instanceof CoreConnectionError && error.kind !== "unavailable") throw error;
      lastError = error;
    }
  }
  throw unavailable(lastError ?? new Error("Core Service did not publish discovery before the timeout"));
}

export async function diagnoseCore(config: CoreConfig, connector = connectLocalCore): Promise<DoctorReport> {
  try {
    const client = await connector(config);
    const health = await client.health();
    return {
      status: "connected",
      serviceVersion: health.serviceVersion,
      schemaVersion: health.schemaVersion,
      baseUrl: client.baseUrl,
      offline: health.offline,
      platform: [client.capabilities.platform?.os, client.capabilities.platform?.arch].filter(Boolean).join("/") || null,
      autoStart: config.autoStart,
      serviceEntry: config.serviceEntry ?? findOnPath("auto-research-core"),
      error: null,
    };
  } catch (error) {
    return {
      status: "disconnected",
      serviceVersion: null,
      schemaVersion: null,
      baseUrl: null,
      offline: null,
      platform: null,
      autoStart: config.autoStart,
      serviceEntry: config.serviceEntry ?? findOnPath("auto-research-core"),
      error: safeError(error),
    };
  }
}

function readDiscovery(path: string): Discovery {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CoreConnectionError("Core Service discovery file is invalid", "configuration");
  }
  if (!value || typeof value !== "object" || typeof (value as Discovery).baseUrl !== "string") {
    throw new CoreConnectionError("Core Service discovery is missing baseUrl", "configuration");
  }
  return value as Discovery;
}

function resolveToken(discovery: Discovery, dataDir: string): string {
  let token: string | undefined;
  if (discovery.tokenFile) {
    const tokenFile = resolve(discovery.tokenFile);
    if (lstatSync(tokenFile).isSymbolicLink() || !lstatSync(tokenFile).isFile()) {
      throw new CoreConnectionError("Core token path must be a regular file", "configuration");
    }
    const realTokenFile = realpathSync(tokenFile);
    const pathFromDataDir = relative(realpathSync(resolve(dataDir)), realTokenFile);
    if (pathFromDataDir.startsWith("..") || isAbsolute(pathFromDataDir)) {
      throw new CoreConnectionError("Core token file must stay inside the configured Core data directory", "configuration");
    }
    const mode = statSync(realTokenFile).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new CoreConnectionError("Core token file permissions are too broad", "configuration");
    }
    token = readFileSync(realTokenFile, "utf8").trim();
  } else if (discovery.tokenSecretName) {
    token = process.env[discovery.tokenSecretName];
  }
  if (!token || token.length < 32) throw new CoreConnectionError("Core Service credential is unavailable", "authentication");
  return token;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreConnectionError("Core Service base URL is invalid", "configuration");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new CoreConnectionError("C1 only attaches to a loopback HTTP Core Service", "configuration");
  }
  return url.toString().replace(/\/$/, "");
}

function validateCompatibility(capabilities: ServiceCapabilities): void {
  if (capabilities.serviceVersion !== CORE_SERVICE_VERSION || capabilities.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    throw new CoreConnectionError(
      `Incompatible Core Service ${capabilities.serviceVersion ?? "unknown"} / schema ${capabilities.schemaVersion ?? "unknown"}`,
      "compatibility",
    );
  }
}

function resolveServiceEntry(configured?: string): string {
  if (configured) {
    const entry = configured.includes("/") ? resolve(configured) : findOnPath(configured);
    if (!entry || !existsSync(entry)) throw new CoreConnectionError("Configured Core Service entry does not exist", "configuration");
    return entry;
  }
  const entry = findOnPath("auto-research-core");
  if (!entry) {
    throw new CoreConnectionError(
      "auto-research-core was not found; install Core or pass --research-core-entry <path>",
      "configuration",
    );
  }
  return entry;
}

function findOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function launchCore(entry: string, config: CoreConfig): Promise<void> {
  const coreArgs = ["--database", config.databasePath, "--data-dir", config.dataDir, "--port", "0"];
  if (config.permissions?.length) coreArgs.push("--permissions", config.permissions.join(","));
  const command = /\.(?:c|m)?js$/.test(entry) ? process.execPath : entry;
  const args = command === process.execPath ? [entry, ...coreArgs] : coreArgs;
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env: { ...process.env } });
    child.once("error", (error) => reject(new CoreConnectionError(`Core Service could not start: ${safeError(error)}`, "unavailable")));
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

async function request<T>(baseUrl: string, token: string, path: string, timeoutMs: number, body?: unknown): Promise<T> {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise<T>((resolveRequest, reject) => {
    const outgoing = httpRequest(new URL(path, baseUrl), {
      method: payload === null ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) response.destroy(new Error("Core Service response exceeds 2 MB"));
        else chunks.push(chunk);
      });
      response.once("error", (error) => reject(unavailable(error)));
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const kind = status === 401 || status === 403 ? "authentication" : "unavailable";
          reject(new CoreConnectionError(`Core Service returned HTTP ${status}`, kind));
          return;
        }
        try {
          resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch {
          reject(new CoreConnectionError("Core Service returned invalid JSON", "unavailable"));
        }
      });
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("Core Service request timed out")));
    outgoing.once("error", (error) => reject(unavailable(error)));
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

function unavailable(error: unknown): CoreConnectionError {
  return error instanceof CoreConnectionError
    ? error
    : new CoreConnectionError(`Core Service is unavailable: ${safeError(error)}`, "unavailable");
}

function openStream(url: string, token: string, timeoutMs: number, signal?: AbortSignal): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolveStream, reject) => {
    let incoming: import("node:http").IncomingMessage | null = null;
    const outgoing = httpRequest(url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }, (response) => {
      incoming = response;
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new CoreConnectionError(`Core stream returned HTTP ${status}`, status === 401 || status === 403 ? "authentication" : "unavailable"));
      } else resolveStream(response);
    });
    const abort = () => { incoming?.destroy(); outgoing.destroy(new DOMException("Aborted", "AbortError")); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("Core stream connection timed out")));
    outgoing.once("error", (error) => reject(unavailable(error)));
    outgoing.end();
  });
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/[a-f0-9]{32,}/gi, "[REDACTED]");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
