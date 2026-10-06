export const CORE_SERVICE_VERSION = "1.0.0";
export const PUBLIC_SCHEMA_VERSION = "1.0.0";

export interface CoreConfig {
  dataDir: string;
  databasePath: string;
  serviceEntry?: string;
  autoStart: boolean;
  timeoutMs: number;
  workspaceId: string;
  stateFile: string;
  permissions: string[];
}

export interface ServiceCapabilities {
  serviceVersion: string;
  schemaVersion: string;
  endpoints: string[];
  offline: boolean;
  startedAt: string;
  platform?: { os?: string; arch?: string };
}

export interface CoreHealth {
  status: "ok";
  serviceVersion: string;
  schemaVersion: string;
  offline: boolean;
}

export interface ProjectSummary {
  id: string;
  title: string;
  direction: string;
  domain: string;
  profile: "smoke" | "exploratory" | "confirmatory";
  status: string;
  updatedAt: string;
}

export interface ProjectStatus {
  schemaVersion: string;
  workspaceId: string;
  project: ProjectSummary;
  questions: Array<{ id: string; version: number; status: string; question: string }>;
  counts: Record<string, number>;
  confirmationObserved: boolean;
  persistence: { branchName: string; lastEventSequence: number; eventCount: number };
}

export interface WorkspaceProjectSummary extends ProjectSummary {
  branchName: string;
  projectStatus: "active" | "archived";
}

export interface WorkspaceProjects {
  schemaVersion: string;
  workspaceId: string;
  projects: WorkspaceProjectSummary[];
}

export interface CoreResult<T = unknown> {
  status: "accepted" | "rejected" | "ok";
  projectId: string | null;
  data: T | null;
  error: { code: string; message: string; retryable?: boolean } | null;
}

export interface DoctorReport {
  status: "connected" | "disconnected";
  serviceVersion: string | null;
  schemaVersion: string | null;
  baseUrl: string | null;
  offline: boolean | null;
  platform: string | null;
  autoStart: boolean;
  serviceEntry: string | null;
  error: string | null;
}

export interface CoreStreamOptions {
  workspaceId: string;
  projectId: string;
  actorId?: string;
  fromSequence?: number;
  jobId?: string;
  logFrom?: number;
  signal?: AbortSignal;
}

export interface CoreStreamEvent {
  event: string;
  id: string | null;
  data: unknown;
}

export interface CoreConnection {
  readonly baseUrl: string;
  readonly capabilities: ServiceCapabilities;
  health(): Promise<CoreHealth>;
  execute<T = unknown>(command: unknown): Promise<CoreResult<T>>;
  query<T = unknown>(query: unknown): Promise<CoreResult<T>>;
  stream(options: CoreStreamOptions): AsyncGenerator<CoreStreamEvent>;
}
