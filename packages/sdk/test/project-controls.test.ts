import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { projectFixture } from "../../contracts/test/fixtures";
import type { ProjectControlOperations, RollbackCapacity } from "@repo/contracts";
import { OperationError } from "../src";

const date = "2026-09-11T00:00:00.000Z";
const environment = {
  id: "preview",
  name: "Preview",
  slug: "preview",
  type: "development",
  gitBranch: "preview",
  projectSlug: "example-preview",
  latestDeploymentStatus: null,
  version: null,
  isApp: false,
  gitProvider: "upload",
};
const resources = {
  production: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
  build: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
  sleepMode: "auto_sleep",
  port: 3000,
  tier: "unlimited",
  requiresLimit: false,
};
const variables = [
  {
    id: "env-a",
    key: "TOKEN",
    value: "********",
    isSecret: true,
    environment: "production",
    createdAt: date,
    updatedAt: date,
  },
];
const preview = {
  projectId: "project/a",
  projectName: "Example",
  selfHosted: true,
  services: [],
  deploymentVolumes: [],
  networks: [],
  totalVolumes: 0,
};
const cases: Array<{
  name: keyof ProjectControlOperations;
  method: string;
  path: string;
  input?: unknown;
  output: unknown;
  envelope?: string;
}> = [
  {
    name: "remove",
    method: "DELETE",
    path: "",
    input: { forceOrphan: true },
    output: { ok: true, message: "deleted", steps: [], orphaned: [], unlinked: [] },
  },
  {
    name: "getInfo",
    method: "GET",
    path: "/info",
    envelope: "data",
    output: {
      project: {
        ...projectFixture("project/a"),
        serviceCount: 0,
        hasMultipleServices: false,
        projectType: "app",
        latestDeploymentId: null,
        latestDeploymentStatus: null,
        latestDeploymentBlocked: false,
        webhookStrategy: null,
        webhookActive: false,
        options: {
          buildCommand: "",
          outputDirectory: "",
          productionPaths: "",
          installCommand: "",
          startCommand: "",
          productionPort: "",
          hasServer: false,
          hasBuild: true,
          workloadType: "static",
          rootDirectory: "./",
          volumes: null,
          resolvedVolumes: [],
          isLoading: false,
          error: null,
        },
      },
      environments: [environment],
    },
  },
  {
    name: "getGitInfo",
    method: "GET",
    path: "/git",
    output: { success: false, error: "No repository connected", code: "NO_REPOSITORY" },
  },
  {
    name: "listBranches",
    method: "GET",
    path: "/branches?page=2",
    input: { page: 2 },
    output: {
      data: [{ name: "main", sha: "abc123", protected: true }],
      pagination: { page: 2, perPage: 100, hasMore: false },
    },
  },
  {
    name: "linkRepo",
    method: "POST",
    path: "/git/link",
    input: { owner: "acme", repo: "example", branch: "main" },
    output: {
      success: true,
      owner: "acme",
      repo: "example",
      branch: "main",
      webhook_strategy: "none",
      auto_deploy: false,
    },
  },
  {
    name: "setReleaseImageSource",
    method: "PUT",
    path: "/release-image-source",
    input: {
      artifactKind: "image",
      mode: "github",
      repo: "acme/example",
      imageTemplate: "ghcr.io/acme/example:{tag}",
    },
    output: projectFixture("project/a"),
    envelope: "data",
  },
  {
    name: "setAutoDeploy",
    method: "POST",
    path: "/auto-deploy",
    input: { enabled: false },
    output: { success: true, auto_deploy: false, webhook_strategy: "none" },
  },
  {
    name: "setWebhookDomain",
    method: "POST",
    path: "/webhook-domain",
    input: { domain: null },
    output: { success: true, webhook_domain: null },
  },
  {
    name: "listDeployments",
    method: "GET",
    path: "/deployments?page=2&perPage=10&environment=production",
    input: { page: 2, perPage: 10, environment: "production" },
    output: { data: [], total: 0, page: 2, perPage: 10 },
  },
  {
    name: "deploymentSession",
    method: "POST",
    path: "/deployment-session",
    output: { session: null },
  },
  {
    name: "clearBuildCache",
    method: "POST",
    path: "/clear-build",
    output: {
      success: true,
      hostScoped: true,
      target: "server",
      serverId: "server-a",
      cachesDeleted: 3,
      bytesReclaimed: 8192,
    },
  },
  {
    name: "getRollbackCapacity",
    method: "GET",
    path: "/rollback-capacity",
    envelope: "data",
    output: {
      window: 5,
      source: "instance-default",
      explicit: null,
      snapshotSizeBytes: null,
      measuredAt: null,
      diskFreeBytes: null,
      diskTotalBytes: null,
      maxWindow: 20,
      diskBudgetFraction: 0.5,
      strategy: "snapshot",
    } satisfies RollbackCapacity,
  },
  {
    name: "checkPorts",
    method: "POST",
    path: "/port-check",
    envelope: "data",
    output: [
      { port: 3000, listening: false, checked: false, skippedReason: "runtime unavailable" },
    ],
  },
  {
    name: "checkOutput",
    method: "POST",
    path: "/output-check",
    envelope: "data",
    output: [{ path: "/", found: true, hasIndex: true, checked: true }],
  },
  {
    name: "getPendingActions",
    method: "GET",
    path: "/pending-actions",
    envelope: "data",
    output: { actions: [] },
  },
  {
    name: "getCommitStatus",
    method: "GET",
    path: "/commit-status",
    envelope: "data",
    output: { supported: false },
  },
  {
    name: "listEnvironments",
    method: "GET",
    path: "/environments",
    output: [environment],
    envelope: "data",
  },
  {
    name: "createEnvironment",
    method: "POST",
    path: "/environments",
    input: { environmentName: "Preview" },
    output: environment,
    envelope: "data",
  },
  {
    name: "listEnvVars",
    method: "GET",
    path: "/env?environment=production",
    input: { environment: "production" },
    output: variables,
    envelope: "data",
  },
  {
    name: "mergeEnvVars",
    method: "PATCH",
    path: "/env",
    input: { environment: "production", upserts: [], deletes: ["TOKEN"] },
    output: { upserted: 0, deleted: 1 },
  },
  { name: "getResources", method: "GET", path: "/resources", output: resources, envelope: "data" },
  {
    name: "updateResources",
    method: "PATCH",
    path: "/resources",
    input: { production: { tier: "unlimited" } },
    output: resources,
    envelope: "data",
  },
  {
    name: "setSleepMode",
    method: "POST",
    path: "/sleep-mode",
    input: { sleep_mode: "always_on" },
    output: { success: true, sleepMode: "always_on" },
  },
  {
    name: "setOptions",
    method: "POST",
    path: "/options",
    input: { buildCommand: "npm run build" },
    output: projectFixture("project/a"),
    envelope: "data",
  },
  {
    name: "setBranch",
    method: "POST",
    path: "/branch",
    input: { branch: "release" },
    output: { success: true, branch: "release" },
  },
  {
    name: "enable",
    method: "POST",
    path: "/enable",
    output: { success: true, message: "Project started" },
  },
  {
    name: "disable",
    method: "POST",
    path: "/disable",
    output: { success: true, message: "Project stopped" },
  },
  {
    name: "retryRouting",
    method: "POST",
    path: "/routing/retry",
    output: { ok: false, warning: "Pending route" },
  },
  {
    name: "runtimeLogs",
    method: "GET",
    path: "/logs?tail=20",
    input: { tail: 20 },
    output: [{ timestamp: date, message: "Ready", level: "info" }],
    envelope: "data",
  },
  {
    name: "getCloneToken",
    method: "GET",
    path: "/clone-token",
    output: { hasToken: false, setAt: null },
  },
  {
    name: "updateCloneToken",
    method: "PATCH",
    path: "/clone-token",
    input: { token: null },
    output: { hasToken: false, setAt: null },
  },
  {
    name: "deletionPreview",
    method: "GET",
    path: "/deletion-preview",
    output: preview,
    envelope: "preview",
  },
];

describe("remote project controls", () => {
  it("retains cleanup details in the shared error family and distinguishes partial success", async () => {
    const body = {
      error: "Cleanup needs a retry",
      code: "PROJECT_TEARDOWN_FAILED",
      canForceOrphan: true,
      steps: [{ step: "container", status: "failed", error: "unreachable" }],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(body, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            message: "Project deleted, but some external cleanup failed",
            steps: body.steps,
            unrecoverable: body.steps,
            unlinked: [],
          },
          { status: 207 },
        ),
      );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const failure = await client.projects.remove("project-a").catch((error) => error);
    expect(failure).toBeInstanceOf(OperationError);
    expect(failure).toMatchObject({
      status: 409,
      statusCode: 409,
      code: body.code,
      details: body,
      body,
    });
    expect(await client.projects.remove("project-a", { forceOrphan: true })).toMatchObject({
      ok: false,
      unrecoverable: body.steps,
    });
  });
  it.each(cases)("preserves the HTTP route and response envelope for $name", async (test) => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://ship.test/api/projects/project%2Fa" + test.path);
      expect(init?.method).toBe(test.method);
      if (test.input && test.method !== "GET")
        expect(JSON.parse(init!.body as string)).toEqual(test.input);
      else expect(init?.body).toBeUndefined();
      return Response.json(test.envelope ? { [test.envelope]: test.output } : test.output);
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const operation = client.projects[test.name] as (
      id: string,
      input?: unknown,
    ) => Promise<unknown>;
    expect(await operation("project/a", test.input)).toEqual(test.output);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates input before sending it and rejects malformed remote results", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ key: "PARTIAL" }] }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(client.projects.runtimeLogs("project-a", { tail: -1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.projects.listEnvVars("project-a")).rejects.toMatchObject({ status: 502 });
  });
});
