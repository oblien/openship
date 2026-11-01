import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Project, Service } from "@repo/db";

const m = vi.hoisted(() => ({
  request: vi.fn(),
  trigger: vi.fn(),
  teardown: vi.fn(),
  native: vi.fn(() => true),
  project: {
    findByIdInOrganization: vi.fn(),
    listEnvVars: vi.fn(),
    bulkSetEnvVars: vi.fn(),
    update: vi.fn(),
  },
  preview: {
    findLeased: vi.fn(),
    claimSources: vi.fn(),
    due: vi.fn(),
    claim: vi.fn(),
    renew: vi.fn(),
    release: vi.fn(),
    update: vi.fn(),
    createEnvironment: vi.fn(),
    admittedDeployment: vi.fn(),
    list: vi.fn(),
    enqueue: vi.fn(),
  },
  service: { listByProject: vi.fn(), update: vi.fn() },
  deployment: { findById: vi.fn() },
  domain: { getPrimaryByProject: vi.fn(), listByProject: vi.fn() },
  protection: { read: vi.fn(), inherit: vi.fn(), sync: vi.fn() },
}));
vi.mock("@repo/platform/engine/lib/route-protection", () => ({
  readPreviewRouteProtection: m.protection.read,
  inheritPreviewRouteProtection: m.protection.inherit,
  syncPreviewRouteProtection: m.protection.sync,
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: m.project,
    pullRequestPreview: m.preview,
    service: m.service,
    deployment: m.deployment,
    domain: m.domain,
  },
}));
vi.mock("@repo/platform/engine/lib/background-context", () => ({
  buildBackgroundContext: (value: unknown) => value,
}));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({
  resolveOrgOwner: async () => ({ userId: "owner" }),
}));
vi.mock("@repo/platform/engine/native/execution-policy", () => ({ nativeJobsEnabled: m.native }));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({ githubFetch: m.request }));
vi.mock("@repo/platform/engine/modules/projects/project-git-webhook", () => ({
  ensureSharedWebhook: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", () => ({
  withProjectCreationLock: (_: string, run: () => unknown) => run(),
  assertProjectQuota: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: m.trigger,
}));
vi.mock("@repo/platform/engine/modules/projects/project-teardown", () => ({
  teardownProject: m.teardown,
}));
vi.mock("@repo/platform/engine/modules/domains/domain.service", () => ({
  addDomain: vi.fn(),
  verifyDomain: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", () => ({
  syncProjectRouteState: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/index", () => ({
  runtimeTarget: { dashboard: "https://dashboard.example" },
}));

import {
  preparePreviewDeployment,
  configurePreviews,
  previewEligible,
  previewEnvironmentInput,
  runPullRequestPreviewsSweep,
} from "@repo/platform/engine/modules/projects/pull-request-previews";
const sha = "a".repeat(40);
const source = {
  id: "source",
  organizationId: "org",
  groupId: "source",
  name: "App",
  slug: "app",
  gitOwner: "owner",
  gitRepo: "repo",
  gitBranch: "main",
  framework: "nextjs",
  previewSettings: { enabled: true, comments: true },
} as Project;
const child = { ...source, id: "child", environmentType: "preview", slug: "app-pr-5" } as Project;
const pr = {
  state: "open" as const,
  number: 5,
  head: { sha, ref: "feature", repo: { full_name: "owner/repo" } },
  base: { ref: "main", repo: { full_name: "owner/repo" } },
};
let intent: any;
beforeEach(() => {
  vi.clearAllMocks();
  intent = {
    id: "intent",
    sourceProjectId: "source",
    organizationId: "org",
    owner: "owner",
    repo: "repo",
    number: 5,
    projectId: "child",
    headSha: null,
    deploymentId: null,
  };
  m.native.mockReturnValue(true);
  m.preview.findLeased.mockImplementation(async () => intent);
  m.preview.list.mockResolvedValue([]);
  m.protection.read.mockResolvedValue(null);
  m.protection.inherit.mockResolvedValue(undefined);
  m.protection.sync.mockResolvedValue(undefined);
  m.preview.claimSources.mockResolvedValue([]);
  m.preview.due.mockImplementation(async () => [intent]);
  m.preview.claim.mockImplementation(async () => ({ ...intent }));
  m.preview.renew.mockResolvedValue(true);
  m.preview.update.mockImplementation(async (_id, _lease, patch) => Object.assign(intent, patch));
  m.preview.admittedDeployment.mockImplementation(async () =>
    intent.deploymentId && intent.headSha === sha
      ? { id: intent.deploymentId, status: "ready" }
      : undefined,
  );
  m.preview.createEnvironment.mockResolvedValue(child);
  m.project.findByIdInOrganization.mockImplementation(async (id) =>
    id === "source" ? source : child,
  );
  m.project.listEnvVars.mockResolvedValue([
    { key: "API_KEY", value: "preview-ciphertext", serviceId: null },
  ]);
  m.service.listByProject.mockResolvedValue([]);
  m.deployment.findById.mockResolvedValue({ id: "dep", status: "ready" });
  m.domain.getPrimaryByProject.mockResolvedValue({ hostname: "preview.example" });
  m.domain.listByProject.mockResolvedValue([]);
  m.request.mockImplementation(async (args) =>
    args.url.endsWith("/pulls/5") ? pr : args.method === "POST" ? { id: 77 } : [],
  );
  m.trigger.mockResolvedValue({ deployment: { id: "dep" } });
  m.teardown.mockResolvedValue({ ok: true });
});

describe("preview templates across stacks", () => {
  test.each(["nextjs", "nuxt", "django", "rails", "laravel", "go", "docker-compose"])(
    "%s inherits build configuration and fresh infrastructure identities",
    (framework) => {
      const result = previewEnvironmentInput(
        { ...source, framework, volumes: ["cache:/root/.cache"] },
        [],
        5,
        "feature",
      );
      expect(result.project).toMatchObject({
        framework,
        autoDeploy: false,
        gitBranch: "feature",
        environmentType: "preview",
        volumes: ["cache:/root/.cache"],
      });
      expect(result.project).not.toHaveProperty("activeDeploymentId");
      expect(result.project).not.toHaveProperty("buildCacheReceipts");
    },
  );
  test("each exposed port gets its own preview URL and literal service secrets are omitted", () => {
    const service = {
      id: "api",
      name: "api",
      exposed: true,
      exposedPort: 3210,
      publicEndpoints: [{ port: 3210 }, { port: 3211 }],
      ports: ["127.0.0.1:9000:3210"],
      environment: { SECRET: "production", URL: "${URL}" },
      advanced: { environmentTemplateKeys: ["URL"] },
      buildArgs: { TOKEN: "production" },
    } as unknown as Service;
    const row = previewEnvironmentInput(source, [service], 5, "feature").services[0]!.row;
    expect(row.publicEndpoints?.map((endpoint) => endpoint.port)).toEqual([3210, 3211]);
    expect(new Set(row.publicEndpoints?.map((endpoint) => endpoint.domain)).size).toBe(2);
    expect(row.environment).toEqual({ URL: "${URL}" });
    expect(row.buildArgs).toEqual({});
    expect(row.ports).toEqual(["3210"]);
    expect(row.namespaceVolumes).toBe(true);
  });
  test("rejects source host mounts and embedded secrets rather than sharing production state", () => {
    for (const volume of ["/data:/data", " /data:/data:ro ", ".:/app", "..:/app"]) {
      expect(() =>
        previewEnvironmentInput({ ...source, volumes: [volume] }, [], 5, "feature"),
      ).toThrow("isolated");
      expect(() =>
        previewEnvironmentInput(
          source,
          [{ name: "app", volumes: [volume] } as Service],
          5,
          "feature",
        ),
      ).toThrow("isolated");
    }
    expect(
      previewEnvironmentInput({ ...source, volumes: ["/data"] }, [], 5, "feature").project.volumes,
    ).toEqual(["/data"]);
    expect(() =>
      previewEnvironmentInput(
        { ...source, buildCommand: "TOKEN=production build" },
        [],
        5,
        "feature",
      ),
    ).toThrow("Environment");
    expect(() =>
      previewEnvironmentInput(
        { ...source, buildCommand: "prepare && TOKEN=production build" },
        [],
        5,
        "feature",
      ),
    ).toThrow("Environment");
  });
  test("disabled services are copied with isolated resources so they can be enabled later", () => {
    const web = { id: "web", name: "web", enabled: true, volumes: ["cache:/cache"] } as Service;
    const tools = {
      id: "tools",
      name: "tools",
      enabled: false,
      namespaceVolumes: false,
      volumes: ["/srv/config:/config:ro", "tools-data:/data"],
      advanced: { networkMode: "host" },
    } as unknown as Service;
    const rows = previewEnvironmentInput(source, [web, tools], 5, "feature").services;
    expect(rows.map((item) => [item.row.name, item.row.enabled])).toEqual([
      ["web", true],
      ["tools", false],
    ]);
    expect(rows[1]!.row).toMatchObject({
      volumes: ["tools-data:/data"],
      namespaceVolumes: true,
      advanced: {},
    });
    expect(rows[1]!.row.advanced).not.toHaveProperty("networkMode");
    expect(tools.advanced).toEqual({ networkMode: "host" });
    expect(tools.volumes).toEqual(["/srv/config:/config:ro", "tools-data:/data"]);
    expect(() =>
      previewEnvironmentInput(
        source,
        [{ ...rows[1]!.row, id: "copied-tools", enabled: true } as Service],
        5,
        "feature",
      ),
    ).not.toThrow();
    for (const enabled of [
      { ...tools, enabled: true },
      { ...tools, enabled: undefined },
      { ...tools, enabled: true, namespaceVolumes: true, advanced: {} },
      { ...tools, enabled: true, volumes: ["site:/usr/share/nginx/html"], advanced: {} },
    ])
      expect(() =>
        previewEnvironmentInput(source, [web, enabled as Service], 5, "feature"),
      ).toThrow(/isolated/);
  });
  test.each(["host", "container:production-db", " container:production-db "])(
    "removes external network and PID namespaces %s only from disabled copies",
    (mode) => {
      const service = {
        id: "tools",
        name: "tools",
        enabled: false,
        advanced: { networkMode: mode, pidMode: mode, healthcheck: { test: ["CMD", "true"] } },
      } as Service;
      const copied = previewEnvironmentInput(source, [service], 5, "feature").services[0]!.row;
      expect(copied.advanced).toEqual({ healthcheck: { test: ["CMD", "true"] } });
      expect(service.advanced).toEqual({
        networkMode: mode,
        pidMode: mode,
        healthcheck: { test: ["CMD", "true"] },
      });
      for (const field of ["networkMode", "pidMode"] as const) {
        expect(() =>
          previewEnvironmentInput(
            source,
            [
              {
                ...service,
                enabled: true,
                advanced: { [field]: mode },
              },
            ],
            5,
            "feature",
          ),
        ).toThrow(/isolated/);
      }
    },
  );
  test.each(["service:db", "none"])("preserves isolated namespace mode %s", (networkMode) => {
    const service = {
      id: "tools",
      name: "tools",
      enabled: false,
      advanced: { networkMode, pidMode: "service:db", healthcheck: { test: ["CMD", "true"] } },
    } as unknown as Service;
    const copied = previewEnvironmentInput(source, [service], 5, "feature").services[0]!.row;
    expect(copied.advanced).toEqual(service.advanced);
  });
  test("forks, drafts, wrong base branches and closed PRs cannot run preview code", () => {
    expect(previewEligible(pr, source)).toBe(true);
    for (const change of [
      { draft: true },
      { state: "closed" as const },
      { head: { ...pr.head, repo: { full_name: "fork/repo" } } },
      { base: { ...pr.base, ref: "other" } },
    ])
      expect(previewEligible({ ...pr, ...change }, source)).toBe(false);
  });
});

describe("preview deployment preparation", () => {
  test("persists protection for the generated host before route synchronization", async () => {
    const protectedSource = { ...source, previewSettings: { enabled: true, comments: false, baseDomain: "preview.test", protectionHostname: "dev.test" } };
    m.project.findByIdInOrganization.mockResolvedValue(protectedSource);
    await preparePreviewDeployment({ organizationId: "org" } as never, child, { id: "intent", token: "lease" });
    expect(m.protection.read).toHaveBeenCalledWith(expect.anything(), protectedSource);
    expect(m.protection.inherit).toHaveBeenCalledWith("child", "app-pr-5.preview.test");
    const { syncProjectRouteState } = await import("@repo/platform/engine/modules/domains/project-route.service");
    expect(m.protection.inherit.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(syncProjectRouteState).mock.invocationCallOrder[0]!);
  });
  test("a missing password stops admission before any domain can be published", async () => {
    m.protection.read.mockRejectedValue(new Error("missing preview password"));
    await expect(preparePreviewDeployment({ organizationId: "org" } as never, child, { id: "intent", token: "lease" }))
      .rejects.toThrow("missing preview password");
    const { syncProjectRouteState } = await import("@repo/platform/engine/modules/domains/project-route.service");
    expect(syncProjectRouteState).not.toHaveBeenCalled();
    expect(m.protection.inherit).not.toHaveBeenCalled();
  });
  test("rejects host mounts introduced by the PR's Compose revision", async () => {
    m.service.listByProject.mockResolvedValue([
      { id: "new", name: "db", volumes: ["/production/data:/var/lib/db"] },
    ]);
    await expect(
      preparePreviewDeployment({ organizationId: "org" } as never, child, {
        id: "intent",
        token: "lease",
      }),
    ).rejects.toThrow("isolated");
    expect(m.service.update).not.toHaveBeenCalled();
  });
  test("long project names keep distinct, valid URLs for every PR and numeric legacy ports", () => {
    const long = { ...source, slug: "a".repeat(50) };
    const service = { id: "api", name: "api", exposed: true, exposedPort: "3210" } as Service;
    const first = previewEnvironmentInput(long, [service], 5, "one").services[0]!.row
      .publicEndpoints![0]!;
    const second = previewEnvironmentInput(long, [service], 6, "two").services[0]!.row
      .publicEndpoints![0]!;
    expect(first.port).toBe(3210);
    expect(first.domain).not.toBe(second.domain);
    expect(first.domain!.length).toBeLessThanOrEqual(63);
  });
});

describe("durable preview reconciliation", () => {
  test("requires cleanup before changing the password source of existing previews", async () => {
    m.preview.list.mockResolvedValue([intent]);
    await expect(configurePreviews({ organizationId: "org" } as never, "source", {
      enabled: true, comments: false, baseDomain: "preview.test", protectionHostname: "dev.test",
    })).rejects.toMatchObject({ code: "PREVIEW_ROUTE_PROTECTION_MANAGED" });
    expect(m.project.update).not.toHaveBeenCalled();
    expect(m.trigger).not.toHaveBeenCalled();
  });
  test("reconciles inherited sessions before reporting a ready preview", async () => {
    m.project.findByIdInOrganization.mockImplementation(async (id) => id === "source"
      ? { ...source, previewSettings: { ...source.previewSettings, protectionHostname: "dev.test" } } : child);
    await runPullRequestPreviewsSweep();
    expect(m.protection.sync).toHaveBeenCalledWith(expect.anything(), "child");
    expect(intent.status).toBe("ready");
  });
  test("allows disabling and queuing cleanup after the GitHub source is disconnected", async () => {
    m.project.findByIdInOrganization.mockResolvedValue({
      ...source,
      gitProvider: null,
      gitOwner: null,
      gitRepo: null,
    });
    m.preview.list.mockResolvedValue([intent]);
    await configurePreviews({ organizationId: "org" } as never, "source", {
      enabled: false,
      comments: true,
    });
    expect(m.project.update).toHaveBeenCalledWith("source", {
      previewSettings: { enabled: false, comments: true, baseDomain: undefined },
    });
    expect(m.preview.enqueue).toHaveBeenCalledWith(intent);
    expect(m.request).not.toHaveBeenCalled();
  });
  test("cleans up the old repository's preview when its source switches repositories", async () => {
    m.project.findByIdInOrganization.mockImplementation(async (id) =>
      id === "source" ? { ...source, gitRepo: "different-repo" } : child,
    );
    await runPullRequestPreviewsSweep();
    expect(m.teardown).toHaveBeenCalledWith(
      expect.anything(),
      "child",
      expect.objectContaining({ wipeVolumes: true }),
    );
    expect(intent.status).toBe("closed");
    expect(m.trigger).not.toHaveBeenCalled();
    expect(m.request.mock.calls.some(([args]) => args.url.endsWith("/pulls/5"))).toBe(false);
  });
  test("does not publish a URL while the deployment reports unsynchronized routing", async () => {
    m.deployment.findById.mockResolvedValue({
      status: "ready",
      meta: { edgeUnsynced: true, deployWarning: "Certificate pending" },
    });
    await runPullRequestPreviewsSweep();
    expect(intent).toMatchObject({ status: "routing", url: null, error: "Certificate pending" });
  });
  test("deploys the current GitHub SHA, copies preview env and updates one comment on repeated deliveries", async () => {
    await runPullRequestPreviewsSweep();
    await runPullRequestPreviewsSweep();
    expect(m.trigger).toHaveBeenCalledTimes(1);
    expect(m.trigger.mock.calls[0]![1]).toMatchObject({
      projectId: "child",
      commitSha: sha,
      previewAdmission: { id: "intent" },
    });
    expect(m.project.listEnvVars).toHaveBeenCalledWith("source", "preview");
    expect(m.project.bulkSetEnvVars).toHaveBeenCalledWith("child", "production", [
      { key: "API_KEY", value: "preview-ciphertext", serviceId: null },
    ]);
    expect(m.request.mock.calls.filter(([args]) => args.method === "POST")).toHaveLength(1);
    expect(intent).toMatchObject({
      status: "ready",
      url: "https://preview.example",
      commentId: "77",
    });
  });
  test("a new commit deploys again; a failed build never publishes a ready URL", async () => {
    intent.headSha = "b".repeat(40);
    intent.deploymentId = "old";
    m.deployment.findById.mockResolvedValue({ status: "failed" });
    await runPullRequestPreviewsSweep();
    expect(m.trigger).toHaveBeenCalledTimes(1);
    expect(intent).toMatchObject({ status: "failed", url: null });
  });
  test("a restarted queued admission resumes through the deployment engine", async () => {
    intent.headSha = sha;
    intent.deploymentId = "dep";
    m.preview.admittedDeployment.mockResolvedValue({ id: "dep", status: "queued" });
    await runPullRequestPreviewsSweep();
    expect(m.trigger).toHaveBeenCalledTimes(1);
  });
  test("close cleanup retries partial teardown before marking the preview closed", async () => {
    m.request.mockImplementation(async (args) =>
      args.url.endsWith("/pulls/5") ? { ...pr, state: "closed" } : [],
    );
    m.teardown.mockResolvedValueOnce({ ok: false });
    await runPullRequestPreviewsSweep();
    expect(intent.nextAttemptAt).toBeInstanceOf(Date);
    expect(intent.error).toContain("cleanup");
    await runPullRequestPreviewsSweep();
    expect(m.teardown).toHaveBeenCalledWith(expect.anything(), "child", {
      force: true,
      wipeVolumes: true,
      preserveWebhook: true,
    });
    expect(intent).toMatchObject({ status: "closed", url: null, nextAttemptAt: null });
    expect(m.trigger).not.toHaveBeenCalled();
  });
  test("lost comment response is recovered by marker without posting twice", async () => {
    m.request.mockImplementation(async (args) =>
      args.url.endsWith("/pulls/5")
        ? pr
        : [{ id: 77, body: "<!-- openship-preview:intent -->\nold" }],
    );
    await runPullRequestPreviewsSweep();
    expect(m.request.mock.calls.some(([args]) => args.method === "POST")).toBe(false);
    expect(m.request.mock.calls.some(([args]) => args.method === "PATCH")).toBe(true);
  });
  test("an expired lease prevents provisioning and deployment", async () => {
    m.preview.renew.mockResolvedValue(false);
    await runPullRequestPreviewsSweep();
    expect(m.trigger).not.toHaveBeenCalled();
    expect(m.preview.createEnvironment).not.toHaveBeenCalled();
    expect(m.teardown).not.toHaveBeenCalled();
  });
});
