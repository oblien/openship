import { vi } from "vitest";
import {
  OpenshipClient,
  type DeploymentBuildStatus,
  type Deployment,
  type Project,
} from "@repo/sdk/client";
import type { Memento, SecretStorage } from "vscode";
import { Connections } from "../src/connections";

export const token = "opsh_pat_test-token";
export const project: Project = {
  id: "project-a",
  organizationId: "org-a",
  groupId: "group-a",
  name: "Example",
  slug: "example",
  gitProvider: "github",
  gitOwner: "example",
  gitRepo: "web",
  gitBranch: "main",
  environmentType: "production",
  activeDeploymentId: "deployment-a",
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:00:00Z",
};
export const deployment: Deployment = {
  id: "deployment-a",
  projectId: project.id,
  organizationId: project.organizationId,
  branch: "main",
  commitSha: null,
  commitMessage: null,
  commitShaBefore: null,
  trigger: "manual",
  environment: "production",
  framework: null,
  status: "ready",
  imageRef: null,
  buildDurationMs: null,
  version: 1,
  releaseVersion: null,
  containerId: null,
  url: "https://app.example.com",
  meta: null,
  envVars: null,
  errorMessage: null,
  errorCode: null,
  errorDetails: null,
  changedPaths: null,
  changedPathsTruncated: false,
  forceAll: false,
  rollbackStrategy: "snapshot",
  artifactRetainedAt: null,
  pinned: false,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
};

export function buildStatus(
  status = "ready",
  overrides: Partial<DeploymentBuildStatus> = {},
): DeploymentBuildStatus {
  return {
    success: true,
    deployment_id: deployment.id,
    project_id: project.id,
    status,
    deploymentStatus: status,
    is_active: status === "ready",
    cancellationPending: false,
    decisionPending: false,
    pendingPrompt: null,
    ...overrides,
  };
}

export function memoryState() {
  const values = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, fallback?: T): T | undefined =>
      values.has(key) ? (values.get(key) as T) : fallback,
    update: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  } as Pick<Memento, "get" | "update">;
  return { values, state };
}

export function memorySecrets() {
  const values = new Map<string, string>();
  const secrets: Pick<SecretStorage, "get" | "store" | "delete"> = {
    get: vi.fn(async (key) => values.get(key)),
    store: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
  return { values, secrets };
}

export function sse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

export const page = <T>(data: T[], page = 1, perPage = 100, total = data.length) => ({
  data,
  page,
  perPage,
  total,
});

export function setupConnections(fetcher?: typeof globalThis.fetch) {
  const state = memoryState();
  const secrets = memorySecrets();
  const changed = vi.fn();
  const requests: Array<{ path: string; method: string; body?: unknown; headers: Headers }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      path: url.pathname,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
    });
    if (fetcher) return fetcher(input, init);
    if (url.pathname.endsWith("/health"))
      return Response.json({ sdk: { protocol: 1, fixedOrganizationScope: true } });
    if (url.pathname.endsWith("/projects")) return Response.json(page([project]));
    if (url.pathname.endsWith(`/projects/${project.id}`)) return Response.json({ data: project });
    if (url.pathname.endsWith(`/deployments/${deployment.id}`))
      return Response.json({ data: deployment });
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  const connections = new Connections(
    state.state,
    secrets.secrets,
    changed,
    (options) => new OpenshipClient({ ...options, fetch }),
    "0.8.0",
  );
  return { connections, state, secrets, changed, fetch, requests };
}

export const connectionInput = {
  name: "production",
  apiUrl: "https://ship.example.com/proxy/api",
  dashboardUrl: "https://dashboard.example.com",
};
