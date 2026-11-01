import "../jobs/_env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ActionRunnerView, ActionWorkflowView, CreateActionWorkflow } from "@repo/contracts";
const h = vi.hoisted(() => ({ fetch: vi.fn(), linked: new Set<string>(), canonical: false }));
vi.mock("@repo/platform/engine/lib/cloud/transport", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/cloud/transport")>()),
  cloudFetchAsOrgOwner: h.fetch,
  resolveOrgCloudUserId: async (org: string) => (h.linked.has(org) ? "linked-owner" : null),
}));
vi.mock("@repo/platform/engine/config/index", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/index")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return h.canonical;
      },
    },
  };
});
import { db, schema, repos, seedOwner, seedServer, type SeededOwner } from "../jobs/_harness";
import { handleApiError } from "../../../src/middleware/error-handler";
import { actionRoutes } from "../../../src/modules/actions/action.routes";
import { domainRoutes } from "../../../src/modules/domains/domain.routes";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { captureExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
const app = new Hono()
  .onError(handleApiError)
  .route("/api/actions", actionRoutes)
  .route("/api/domains", domainRoutes);
let owner: SeededOwner;
const config = {
  mode: "native" as const,
  labels: ["linux"],
  image: null,
  cpu: 1,
  memoryMb: 1024,
  maxParallel: 1,
  allowDockerSocket: false,
};
const source =
  "name: Check\non: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: echo ok\n";
const workflow: ActionWorkflowView = {
  id: "cloud-workflow",
  controller: "openship",
  githubWorkflowId: null,
  name: "Check",
  owner: null,
  repo: null,
  path: ".openship/workflows/check.yml",
  ref: "main",
  source,
  runnerIds: ["cloud-runner"],
  storageDestinationId: null,
  variables: {},
  plan: { name: "Check", triggers: ["workflow_dispatch"], jobs: [], inputs: [] },
  lastError: null,
  secretNames: [],
  enabled: true,
  allowForks: false,
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
  projectIds: ["cloud-project"],
};
const runner: ActionRunnerView = {
  id: "cloud-runner",
  name: "Cloud",
  serverId: "cloud-server",
  kind: "server",
  config,
  capabilities: null,
  enabled: true,
  checkedAt: null,
  error: null,
  labels: [],
};
const input: CreateActionWorkflow = {
  name: workflow.name,
  owner: null,
  repo: null,
  path: workflow.path,
  ref: "main",
  source,
  runnerIds: [runner.id],
  projectIds: ["cloud-project"],
};
const policy = {
  project: { id: "cloud-project", name: "Cloud app", owner: null, repo: null, branch: null },
  mode: "manual",
  workflowIds: [workflow.id],
  requiredWorkflowIds: [],
  requests: [],
};
const run = {
  id: "cloud-run",
  controller: "openship",
  workflowId: workflow.id,
  name: "Check",
  number: 1,
  attempt: 1,
  status: "success",
  owner: null,
  repo: null,
  revision: "a".repeat(40),
  ref: "main",
  eventName: "workflow_dispatch",
  actor: "owner",
  untrusted: false,
  approvedAt: null,
  cancelRequestedAt: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  createdAt: workflow.createdAt,
  settledAt: null,
  plan: workflow.plan,
  jobs: [],
};
const headers = () => ({
  ...owner.auth,
  "X-Organization-Id": owner.orgId,
  "content-type": "application/json",
});
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: headers(),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const context = (user = owner) => ({
  ...buildBackgroundContext({ userId: user.userId, organizationId: user.orgId }),
  scopeMode: "resource" as const,
});
async function localProject(user = owner) {
  const group = await repos.projectGroup.create({
    organizationId: user.orgId,
    name: "Local",
    slug: `local-${user.orgId}`,
  });
  return repos.project.create({
    organizationId: user.orgId,
    groupId: group.id,
    name: "Local app",
    slug: `local-${user.orgId}`,
  });
}
async function localWorkflow(user = owner) {
  const serverId = await seedServer(user.orgId);
  const savedRunner = await repos.actions.saveRunner({
    id: `runner-${serverId}`,
    organizationId: user.orgId,
    serverId,
    name: "Local",
    config,
  });
  const row = await repos.actions.saveWorkflow({
    id: `workflow-${serverId}`,
    organizationId: user.orgId,
    name: "Local workflow",
    path: workflow.path,
    ref: "main",
    source,
    owner: null,
    repo: null,
    runnerIds: [savedRunner.id],
    definition: { name: "Check", triggers: { workflow_dispatch: {} }, jobs: [] },
    authority: await captureExecutionAuthority(context(user)),
  });
  return { row, savedRunner };
}
beforeEach(async () => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
  owner = await seedOwner({ bound: false });
  h.linked.clear();
  h.linked.add(owner.orgId);
  h.canonical = false;
  h.fetch.mockReset().mockImplementation(async (_org: string, path: string, init?: RequestInit) => {
    const p = new URL(path, "http://cloud.test").pathname;
    let data: unknown;
    if (p === "/api/actions/project" || p === "/api/actions/project/requests") data = policy;
    else if (p === "/api/actions/workflows/import") data = [workflow];
    else if (p === "/api/actions/workflows" && init?.method === "GET") data = [workflow];
    else if (
      p.includes("/dispatch") ||
      p.includes("/rerun") ||
      p.includes("/cancel") ||
      p.includes("/approve") ||
      p === "/api/actions/runs/cloud-run"
    )
      data = run;
    else if (p === "/api/actions/runs") data = [run];
    else if (p.endsWith("/artifacts/download")) data = { url: "https://cloud.test/artifact" };
    else if (p.endsWith("/artifacts")) data = [];
    else if (p.endsWith("/events"))
      data = {
        events: [
          { version: 1, sequence: 1, type: "log", time: workflow.createdAt, message: "Cloud log" },
        ],
        next: 1,
        complete: true,
      };
    else if (p === "/api/actions/projects") data = [policy.project];
    else if (p === "/api/actions/runners" && init?.method === "GET") data = [runner];
    else if (p.endsWith("/inspect") || p.endsWith("/emulation"))
      data = {
        os: "linux",
        architecture: "x64",
        docker: true,
        git: true,
        node: true,
        distribution: null,
        version: null,
      };
    else if (p.includes("/runners")) data = runner;
    else data = workflow;
    return Response.json(init?.method === "DELETE" ? { success: true } : { data });
  });
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});
describe("connected Cloud Actions authority", () => {
  it("loads the policy, workflows and runs used by Desktop's project page", async () => {
    for (const [path, expected] of [
      ["/actions/project?projectId=cloud-project", policy],
      ["/actions/workflows", [workflow]],
      ["/actions/runs?projectId=cloud-project", [run]],
    ] as const) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: expected });
    }
    expect(h.fetch.mock.calls.map((call) => call[0])).toEqual([
      owner.orgId,
      owner.orgId,
      owner.orgId,
    ]);
    expect(await repos.project.findById("cloud-project")).toBeUndefined();
    expect(await repos.actions.workflow(owner.orgId, workflow.id)).toBeUndefined();
  });
  it.each([
    ["/actions/workflows/cloud-workflow", "GET", undefined, workflow],
    ["/actions/workflows/cloud-workflow", "PATCH", input, workflow],
    ["/actions/workflows/cloud-workflow", "DELETE", undefined, { success: true }],
    ["/actions/workflows/cloud-workflow/dispatch", "POST", { idempotencyKey: "dispatch-key" }, run],
    ["/actions/runs?workflowId=cloud-workflow", "GET", undefined, [run]],
    ["/actions/runs/cloud-run", "GET", undefined, run],
    ["/actions/runs/cloud-run/cancel", "POST", undefined, run],
    ["/actions/runs/cloud-run/approve", "POST", {}, run],
    ["/actions/runs/cloud-run/rerun", "POST", { idempotencyKey: "rerun-key" }, run],
    ["/actions/runs/cloud-run/artifacts", "GET", undefined, []],
    [
      "/actions/runs/cloud-run/artifacts/download",
      "POST",
      { artifactId: 1 },
      { url: "https://cloud.test/artifact" },
    ],
    [
      "/actions/runners/cloud-runner",
      "PATCH",
      { name: "Cloud", serverId: "cloud-server", config },
      runner,
    ],
    ["/actions/runners/cloud-runner", "DELETE", undefined, { success: true }],
    ["/actions/runners/cloud-runner/probe", "POST", undefined, runner],
  ])("resolves %s from Cloud without copying records", async (path, method, body, expected) => {
    const response = await request(path, method, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(method === "DELETE" ? expected : { data: expected });
    expect(h.fetch.mock.calls[0].slice(0, 2)).toEqual([owner.orgId, `/api${path}`]);
  });
  it("resumes Cloud job logs using the durable cursor", async () => {
    const response = await request("/actions/jobs/cloud-job/events?after=0");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      next: 1,
      complete: true,
      events: [{ message: "Cloud log" }],
    });
    expect(h.fetch.mock.calls[0][1]).toBe("/api/actions/jobs/cloud-job/events?after=0");
  });
  it.each([
    ["/actions/workflows", "POST", input],
    ["/actions/workflows/import", "POST", { workflows: [input] }],
    [
      "/actions/project",
      "PUT",
      {
        projectId: "cloud-project",
        mode: "manual",
        workflowIds: [workflow.id],
        requiredWorkflowIds: [],
      },
    ],
    [
      "/actions/project/requests",
      "POST",
      {
        projectId: "cloud-project",
        requestId: "cloud-request",
        action: "retry",
        idempotencyKey: "retry-key",
      },
    ],
    ["/actions/runners", "POST", { serverId: "cloud-server", name: "Cloud", config }],
    ["/actions/runners/inspect", "POST", { serverId: "cloud-server" }],
    ["/actions/runners/emulation", "POST", { serverId: "cloud-server" }],
  ])("routes all targets of %s together", async (path, method, input) => {
    const response = await request(path, method, input);
    expect(response.status).toBe(200);
    expect(h.fetch.mock.calls[0].slice(0, 2)).toEqual([owner.orgId, `/api${path}`]);
    expect(JSON.parse(h.fetch.mock.calls[0][2].body)).toEqual(input);
  });
  it("keeps local records local and merges both inventories for pickers", async () => {
    const project = await localProject();
    const { row, savedRunner } = await localWorkflow();
    const response = await request(`/actions/project?projectId=${project.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.project.id).toBe(project.id);
    expect((await request(`/actions/workflows/${row.id}`)).status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
    for (const [path, ids] of [
      ["/actions/workflows", [workflow.id, row.id]],
      ["/actions/projects", [policy.project.id, project.id]],
      ["/actions/runners", [runner.id, savedRunner.id]],
    ] as const) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect((await response.json()).data.map((item: { id: string }) => item.id)).toEqual(ids);
    }
  });
  it("does not proxy local resources belonging to another tenant", async () => {
    const foreign = await seedOwner();
    const project = await localProject(foreign);
    const { row, savedRunner } = await localWorkflow(foreign);
    for (const path of [
      `/actions/project?projectId=${project.id}`,
      `/actions/workflows/${row.id}`,
      `/actions/runners/${savedRunner.id}/probe`,
    ])
      expect((await request(path, path.endsWith("probe") ? "POST" : "GET")).status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("preserves foreign run and job isolation before consulting Cloud", async () => {
    const foreign = await seedOwner();
    const { row } = await localWorkflow(foreign);
    const id = `run-${row.id}`;
    await db.insert(schema.actionRun).values({
      id,
      organizationId: foreign.orgId,
      workflowId: row.id,
      number: 1,
      idempotencyKey: id,
      source,
      plan: row.definition,
      authority: row.authority,
      configuration: {
        owner: null,
        repo: null,
        path: row.path,
        defaultBranch: "main",
        runnerIds: row.runnerIds,
        variables: {},
        secrets: {},
      },
      revision: "local",
      ref: "main",
      eventName: "workflow_dispatch",
      event: {},
      actor: "owner",
    });
    await db.insert(schema.actionJob).values({
      id: `job-${id}`,
      organizationId: foreign.orgId,
      runId: id,
      jobKey: "check",
      matrixIndex: 0,
    });
    expect((await request(`/actions/runs/${id}`)).status).toBe(404);
    expect((await request(`/actions/jobs/job-${id}/events`)).status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("enforces read-only credentials and refreshes membership before Cloud writes", async () => {
    await expect(
      getPlatformKernel().actions.updateProjectPolicy(
        {
          ...context(),
          credential: { organizationId: null, readOnly: true },
        },
        { projectId: "cloud-project", mode: "manual", workflowIds: [], requiredWorkflowIds: [] },
      ),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    const foreign = await seedOwner();
    await expect(
      getPlatformKernel().actions.projectPolicy(
        { ...context(), organizationId: foreign.orgId },
        { projectId: "cloud-project" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not turn a database failure into an upstream operation", async () => {
    const lookup = vi
      .spyOn(repos.actions, "resourceExists")
      .mockRejectedValueOnce(new Error("Database unavailable"));
    try {
      expect((await request("/actions/workflows/cloud-workflow")).status).toBe(500);
      expect(h.fetch).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });
  it("rejects mixed imports and policies before any writes", async () => {
    const project = await localProject();
    const { row } = await localWorkflow();
    for (const [path, method, body] of [
      [
        "/actions/workflows/import",
        "POST",
        { workflows: [input, { ...input, projectIds: [project.id] }] },
      ],
      [
        "/actions/project",
        "PUT",
        {
          projectId: "cloud-project",
          mode: "manual",
          workflowIds: [row.id],
          requiredWorkflowIds: [],
        },
      ],
      ["/actions/workflows/cloud-workflow", "PATCH", { ...input, projectIds: [project.id] }],
      ["/actions/runs?workflowId=cloud-workflow&projectId=" + project.id, "GET", undefined],
    ] as const) {
      const response = await request(path, method, body);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("ACTIONS_MIXED_AUTHORITY");
    }
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await repos.actions.listWorkflows(owner.orgId)).map((item) => item.id)).toEqual([
      row.id,
    ]);
  });
  it("validates inputs and rejects unauthenticated or instance-bound credentials", async () => {
    expect((await app.request("/api/actions/project?projectId=cloud-project")).status).toBe(401);
    expect((await request("/actions/workflows", "POST", { ...input, runnerIds: [] })).status).toBe(
      400,
    );
    owner = await seedOwner();
    h.linked.add(owner.orgId);
    expect((await request("/actions/project?projectId=cloud-project")).status).toBe(409);
    expect((await request("/actions/workflows")).status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["unreachable", () => null],
    ["invalid response", () => new Response("<html>Gateway error</html>")],
    ["upstream refusal", () => Response.json({ error: "Forbidden" }, { status: 403 })],
  ] as const)(
    "keeps local workflows when optional Cloud discovery returns %s",
    async (_name, reply) => {
      const { row } = await localWorkflow();
      h.fetch.mockResolvedValueOnce(reply());
      const response = await request("/actions/workflows");
      expect(response.status).toBe(200);
      expect((await response.json()).data.map((item: ActionWorkflowView) => item.id)).toEqual([
        row.id,
      ]);
      expect(await repos.actions.workflow(owner.orgId, workflow.id)).toBeUndefined();
    },
  );
  it("surfaces unavailable Cloud and upstream policy errors for Cloud-owned resources", async () => {
    h.fetch.mockResolvedValueOnce(null);
    const lost = await request("/actions/workflows/cloud-workflow");
    expect(lost.status).toBe(503);
    expect((await lost.json()).code).toBe("CLOUD_UNREACHABLE");
    h.fetch.mockResolvedValueOnce(
      Response.json(
        { error: "Approval key changed", code: "ACTIONS_APPROVAL_CHANGED" },
        { status: 409 },
      ),
    );
    const changed = await request("/actions/runs/cloud-run/approve", "POST", {});
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe("ACTIONS_APPROVAL_CHANGED");
    h.fetch.mockResolvedValueOnce(new Response("<html>Gateway error</html>"));
    expect((await request("/actions/workflows/cloud-workflow")).status).toBe(502);
  });
  it("stays local while disconnected or on the canonical Cloud API", async () => {
    h.linked.clear();
    expect((await request("/actions/project?projectId=cloud-project")).status).toBe(404);
    expect((await request("/actions/workflows")).status).toBe(200);
    h.linked.add(owner.orgId);
    h.canonical = true;
    expect((await request("/actions/project?projectId=cloud-project")).status).toBe(404);
    expect((await request("/actions/workflows")).status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("uses the same boundary for direct platform calls", async () => {
    expect(
      (await getPlatformKernel().actions.projectPolicy(context(), { projectId: "cloud-project" }))
        .data,
    ).toEqual(policy);
    await expect(
      getPlatformKernel().actions.projectPolicy(
        { ...context(), scopeMode: "fixed" },
        { projectId: "cloud-project" },
      ),
    ).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("preserves existing domain forwarding including upstream errors", async () => {
    h.fetch.mockResolvedValueOnce(
      Response.json({ data: [{ id: "cloud-domain", hostname: "app.example.test" }] }),
    );
    const response = await request("/domains?projectId=cloud-project");
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].hostname).toBe("app.example.test");
    h.fetch.mockResolvedValueOnce(
      Response.json({ error: "Route conflict", code: "DOMAIN_CONFLICT" }, { status: 409 }),
    );
    const add = await request("/domains", "POST", {
      projectId: "cloud-project",
      hostname: "app.example.test",
    });
    expect(add.status).toBe(409);
    expect((await add.json()).code).toBe("DOMAIN_CONFLICT");
  });
});
