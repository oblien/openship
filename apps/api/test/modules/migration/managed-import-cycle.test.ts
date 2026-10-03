import "../jobs/_env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ensure: vi.fn(), discover: vi.fn(), runtime: vi.fn(), build: vi.fn(), teardown: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", async load => {
  const actual = await load<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("@repo/platform/engine/lib/cloud-docker-workspace", async load => ({
  ...await load<typeof import("@repo/platform/engine/lib/cloud-docker-workspace")>(), ensureCloudWorkspaceHost: h.ensure,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-access", async load => ({
  ...await load<typeof import("@repo/platform/engine/lib/cloud-workspace-access")>(), assertManagedServerCanWork: async () => {},
}));
vi.mock("@repo/platform/engine/lib/plan-guard", async load => ({
  ...await load<typeof import("@repo/platform/engine/lib/plan-guard")>(), planProjectLimit: async () => null,
}));
vi.mock("@repo/platform/engine/modules/migration/docker-inspect.service", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/migration/docker-inspect.service")>(), discoverServerStack: h.discover,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/migration/migration-runtime")>(), createMigrationDockerRuntime: h.runtime,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/deployments/build.service")>(), requestBuildAccess: h.build,
}));
vi.mock("@repo/platform/engine/modules/projects/project-teardown", async load => ({
  ...await load<typeof import("@repo/platform/engine/modules/projects/project-teardown")>(), teardownProject: h.teardown,
}));

import { repos } from "@repo/db";
import { DockerRuntime } from "@repo/adapters";
import type { ExecutionContext } from "@repo/platform";
import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";
import { seedOrg, seedDeployment } from "../../helpers/seed";
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";

let ctx: ExecutionContext, sourceId: string, targetId: string, workspaceId: string;
let events: string[], running: Set<string>;
const runningId = "original-web", dormantId = "original-worker";
const terminal = ["awaiting_cutover", "partial", "succeeded", "rolled_back", "failed"];

async function settled(id: string) {
  for (let tries = 0; tries < 200; tries++) {
    const row = await repos.dockerMigrationRun.findById(id);
    if (row?.executionFinishedAt && terminal.includes(row.status)) return row;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const row = await repos.dockerMigrationRun.findById(id);
  throw new Error(`Migration did not settle: ${JSON.stringify({ status: row?.status, error: row?.errorMessage, events })}`);
}
const begin = () => migrationOrchestrator.begin(ctx, {
  organizationId: ctx.organizationId, sourceServerId: sourceId, targetServerId: targetId,
  projectName: "Imported application", serviceNames: ["web", "worker"],
  serviceContainerIds: [runningId, dormantId], transferMode: "stream", killOriginals: false,
});

beforeEach(async () => {
  vi.resetAllMocks();
  events = []; running = new Set([runningId]);
  ctx = await seedOrg() as ExecutionContext;
  const workspace = await repos.cloudWorkspace.create({ organizationId: ctx.organizationId, name: "Destination" });
  workspaceId = workspace.id;
  targetId = (await repos.server.findByWorkspace(workspaceId, ctx.organizationId))!.id;
  sourceId = (await repos.server.create({ organizationId: ctx.organizationId, purpose: "migration_source",
    sshHost: "93.184.216.34", sshAuthMethod: "password", sshPassword: encryptSecretField("fixture-password"), sshHostKey: "fixture-key" })).id;
  h.ensure.mockImplementation(async () => {
    events.push("ensure");
    expect(running.has(runningId)).toBe(true);
    expect((await repos.cloudWorkspace.findById(workspaceId))?.activity?.scope).toMatch(/^migration:/);
    return "fixture-provider-vm";
  });
  h.discover.mockImplementation(async (id, org) => {
    expect(id).toBe(sourceId); expect(org).toBe(ctx.organizationId);
    return { services: [["web", runningId], ["worker", dormantId]].map(([name, containerId]) => ({
      name, containerId, image: "busybox:1.37", imageId: "fixture-image", source: "container",
      running: running.has(containerId!), ports: [], volumes: [], networks: [], dependsOn: [], warnings: [],
      env: { TOKEN: "fixture-app-secret" },
    })), groups: [], openshipProjects: [], warnings: [] };
  });
  h.runtime.mockImplementation(async (id, org) => {
    expect([sourceId, targetId]).toContain(id); expect(org).toBe(ctx.organizationId);
    const source = id === sourceId;
    return Object.setPrototypeOf({
      name: "docker", assertReachable: async () => {}, assertBackupAccess: async () => {},
      imageExistsLocally: async () => false, // Transfer itself is covered by the real SSH/Cloud E2E.
      inspectContainer: async (containerId: string) => ({ id: containerId, state: running.has(containerId) ? "running" : "exited" }),
      stop: async (containerId: string) => { events.push(`stop:${containerId}`); running.delete(containerId); },
      start: async (containerId: string) => { events.push(`start:${containerId}`); running.add(containerId); },
      destroy: async (containerId: string) => { events.push(`destroy:${containerId}`); running.delete(containerId); },
      listAllContainers: async () => [], listDeploymentContainers: async () => source ? [] : [{ containerId: "target-web" }],
      dispose: async () => {},
      docker: { getContainer: () => ({ inspect: async () => ({ Mounts: [] }) }), listContainers: async () => [] },
    }, DockerRuntime.prototype);
  });
  h.build.mockImplementation(async (actor, input) => {
    expect(actor.organizationId).toBe(ctx.organizationId);
    // The ordinary deployment worker must acquire its own host admission.
    expect((await repos.cloudWorkspace.findById(workspaceId))?.activity).toBeNull();
    expect(running.has(runningId)).toBe(false);
    events.push("deploy");
    const project = (await repos.project.findById(input.projectId))!;
    const deployment = await seedDeployment(project);
    await repos.project.setActiveDeployment(project.id, deployment.id);
    return { deployment_id: deployment.id };
  });
  h.teardown.mockImplementation(async (_actor, projectId) => {
    events.push("delete-draft");
    await repos.project.deleteHard(projectId);
  });
});
afterEach(() => vi.restoreAllMocks());

it("imports through the shared planner and deployment handoff, then waits for explicit cutover", async () => {
  const started = await begin();
  const run = await settled(started.migrationId);
  expect(run.status, run.errorMessage ?? run.logs ?? "").toBe("awaiting_cutover");
  expect(events.slice(0, 3)).toEqual(["ensure", `stop:${runningId}`, "deploy"]);
  expect(h.ensure).toHaveBeenCalledTimes(1);
  expect(h.build).toHaveBeenCalledTimes(1);
  expect(h.build.mock.calls[0]![1]).toMatchObject({ serverId: targetId, runtimeMode: "docker", serviceDeploymentMode: "services" });
  expect(h.build.mock.calls[0]![2]).toMatchObject({ strictServiceScope: true });
  expect(run.recovery.sourceRunningContainerIds).toEqual({ web: runningId });
  expect(running.has(runningId)).toBe(false);
  const project = await repos.project.findById(run.projectId!);
  expect(project).toMatchObject({ serverId: targetId, workspaceId });
  expect((await repos.service.listByProject(run.projectId!)).map(service => service.name).sort()).toEqual(["web", "worker"]);
  expect(await migrationOrchestrator.resolveCutover(run.id, ctx.organizationId, started.confirmationToken, false)).toMatchObject({ ok: true });
  expect((await repos.dockerMigrationRun.findById(run.id))?.status).toBe("succeeded");
  expect(events.some(event => event.startsWith("destroy:"))).toBe(false);
  // An explicit Keep retains the existing cross-server import semantics.
  expect(running).toEqual(new Set([runningId]));
});

it("leaves the source untouched if the managed host cannot be prepared", async () => {
  h.ensure.mockRejectedValueOnce(new Error("provider temporarily unavailable"));
  const run = await settled((await begin()).migrationId);
  expect(run.status).toBe("rolled_back");
  expect(run.errorMessage).toContain("provider temporarily unavailable");
  expect(h.discover).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  expect(running).toEqual(new Set([runningId]));
  expect(run.projectId).toBeNull();
});

it("restores only originally running sources after deployment refusal and retries draft cleanup", async () => {
  h.build.mockRejectedValueOnce(new Error("deployment refused"));
  h.teardown.mockRejectedValueOnce(new Error("temporary database outage"));
  const started = await begin();
  const run = await settled(started.migrationId);
  expect(run.status, run.logs ?? "").toBe("rolled_back");
  expect(running).toEqual(new Set([runningId]));
  expect(events).toContain(`start:${runningId}`);
  expect(events).not.toContain(`start:${dormantId}`);
  expect(run.projectId).toBe(run.recovery.createdProjectId);
  expect((await repos.dockerMigrationRun.listInFlight()).map(row => row.id)).toContain(run.id);
  // Recovery's grace period is wall-clock admission, not part of the cleanup.
  const { db, schema, eq } = await import("@repo/db");
  await db.update(schema.dockerMigrationRun).set({ lastEventAt: new Date(Date.now() - 60_000) }).where(eq(schema.dockerMigrationRun.id, run.id));
  await migrationOrchestrator.recoverInterruptedMigrations();
  expect(h.teardown).toHaveBeenCalledTimes(2);
  expect((await repos.dockerMigrationRun.findById(run.id))?.projectId).toBeNull();
  expect((await repos.dockerMigrationRun.listInFlight()).map(row => row.id)).not.toContain(run.id);
});
