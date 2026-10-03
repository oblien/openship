import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase, schema, type DatabaseConnection } from "../../../../packages/db/src/factory";
import { createCloudWorkspaceRepo } from "../../../../packages/db/src/repos/cloud-workspace.repo";
import { currentManagedCommandTracking } from "../../../../packages/adapters/src/runtime/cloud/command-tracking";
import { AppError, type ManagedCommandRef } from "@repo/core";

const h = vi.hoisted(() => ({
  repositories: new Map<string, ReturnType<typeof createCloudWorkspaceRepo>>(),
  bindings: new Map<string, string>(),
  remote: vi.fn(),
  recover: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    cloudWorkspace: new Proxy({}, {
      get: (_, method) => (id: string, ...args: unknown[]) => {
        const repo = h.repositories.get(id);
        if (!repo) throw new Error(`Unknown test server: ${id}`);
        return (repo as any)[method](id, ...args);
      },
    }),
    cloudDockerWorkspace: {
      find: async ({ ownerWorkspaceId }: { ownerWorkspaceId: string }) => ({
        workspaceId: h.bindings.get(ownerWorkspaceId),
      }),
    },
    project: { listByWorkspace: async () => [] },
  },
  // Each simulated installation has its own PGlite. The real process mutex and
  // SQL admission rows still fence work across those independent databases.
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({
  requireLinkedCloudServer: async (org: string, id: string) =>
    h.repositories.get(id)!.findByIdInOrganization(id, org),
  remoteCloudRequest: h.remote,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-host", () => ({
  openCloudWorkspaceExecutor: async () => ({ recoverCommand: h.recover, dispose: h.dispose }),
}));
import {
  withCloudWorkspaceActivity,
  holdCloudWorkspaceActivity,
  reconcileSettledCloudActivity,
} from "@repo/platform/engine/lib/cloud-workspace-lock";

const databases: DatabaseConnection[] = [];
let cloud: ReturnType<typeof createCloudWorkspaceRepo>;
let local: ReturnType<typeof createCloudWorkspaceRepo>;
let host: Awaited<ReturnType<typeof cloud.create>>;
let a: typeof host, b: typeof host;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const command: ManagedCommandRef = { workspaceId: "provider-vm", marker: "openship-exec-test" };

beforeAll(async () => {
  for (let i = 0; i < 3; i++) databases.push(await createDatabase({
    driver: "pglite", dataDir: "memory://", registerExitHook: false,
    migrationsDir: fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url)),
  }));
}, 60_000);
afterAll(async () => { await Promise.all(databases.map(database => database.close())); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.repositories.clear();
  h.bindings.clear();
  for (const { db } of databases) {
    await db.delete(schema.servers);
    await db.delete(schema.cloudWorkspace);
    await db.delete(schema.organization);
    await db.insert(schema.organization).values([{ id: "org", name: "Org" }, { id: "other", name: "Other" }]);
  }
  const [cloudRepo, aRepo, bRepo] = databases.map(database => createCloudWorkspaceRepo(database.db));
  cloud = cloudRepo!;
  local = aRepo!;
  host = await cloud.create({ organizationId: "org", name: "Managed" });
  const remote = { apiUrl: "https://cloud.test", userId: "remote-user", organizationId: "org", serverId: "remote-server", workspaceId: host.id };
  a = await local.link({ organizationId: "org", name: "Installation A", remote });
  b = await bRepo!.link({ organizationId: "org", name: "Installation B", remote });
  for (const [row, repo] of [[host, cloud], [a, local], [b, bRepo!]] as const) {
    h.repositories.set(row.id, repo);
    h.bindings.set(row.id, command.workspaceId);
  }
  h.recover.mockResolvedValue(undefined);
  h.dispose.mockResolvedValue(undefined);
  h.remote.mockImplementation(async (_org: string, path: string, input: RequestInit) => {
    const value = JSON.parse(input.body as string);
    const controllerId = `remote-user:${value.controllerId}`;
    if (path.endsWith("/release")) {
      await cloud.releaseActivity(host.id, "org", value.id, controllerId, value.projects);
      return { id: value.id, released: true };
    }
    const activity = await cloud.claimActivity(host.id, "org", {
      id: value.id, controllerId, scope: value.scope, startedAt: new Date().toISOString(),
    }, false, value.projects);
    return { id: activity.id };
  });
});

describe("managed server admission across independent installations", () => {
  it("prevents two installations from claiming the same project identity", async () => {
    const claim = { id: randomUUID(), controllerId: "controller-a", scope: "project:shared", startedAt: new Date().toISOString() };
    const projects = [{ id: "shared-project", name: "Shared" }];
    await cloud.claimActivity(host.id, "org", claim, false, projects);
    await cloud.releaseActivity(host.id, "org", claim.id, claim.controllerId, projects);
    await expect(cloud.claimActivity(host.id, "org", { ...claim, id: randomUUID(), controllerId: "controller-b" }, false, projects))
      .rejects.toMatchObject({ code: "CLOUD_PROJECT_IDENTITY_CONFLICT" });
    expect((await cloud.findById(host.id))!.linkedProjects).toEqual([{ controllerId: "controller-a", projects }]);
    // A stale/foreign release cannot erase the original installation's presence.
    await cloud.releaseActivity(host.id, "org", claim.id, "controller-b", []);
    expect((await cloud.findById(host.id))!.linkedProjects[0]!.projects).toEqual(projects);
  });

  it("records deletion receipts only for the matching organization, server and operation", async () => {
    const server = (await databases[0]!.db.query.servers.findMany()).find(server => server.workspaceId === host.id)!;
    const operation = { id: randomUUID(), kind: "delete" as const, status: "queued" as const,
      requestedAt: new Date().toISOString(), attempts: 0, nextAttemptAt: null, error: null, logs: [] };
    await expect(cloud.finishDeletion(host.id, "org")).rejects.toThrow("not requested");
    await cloud.requestOperation(host.id, "org", operation);
    await expect(cloud.finishDeletion(host.id, "other")).rejects.toThrow("not requested");
    await cloud.finishDeletion(host.id, "org");
    expect(await cloud.findById(host.id)).toBeUndefined();
    expect(await cloud.findDeletion(server.id, "org", operation.id)).toMatchObject({ workspaceId: host.id, serverId: server.id });
    expect(await cloud.findDeletion(server.id, "other", operation.id)).toBeUndefined();
    expect(await cloud.findDeletion(server.id, "org", "another-operation")).toBeUndefined();
    expect(await cloud.findDeletion("another-server", "org", operation.id)).toBeUndefined();
  });

  it("fences a second installation and Cloud lifecycle while work runs, including nested helpers", async () => {
    const ready = deferred(), finish = deferred();
    const running = withCloudWorkspaceActivity(a.id, async () => {
      await withCloudWorkspaceActivity(a.id, async () => ready.resolve());
      await finish.promise;
    }, undefined, { scope: "project:a" });
    await ready.promise;
    const never = vi.fn();
    try {
      await expect(withCloudWorkspaceActivity(b.id, never)).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" });
      await expect(withCloudWorkspaceActivity(host.id, never, undefined, { lifecycle: true })).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" });
      expect(never).not.toHaveBeenCalled();
      const claim = (await cloud.findById(host.id))!.activity!;
      await cloud.releaseActivity(host.id, "other", claim.id, claim.controllerId);
      await cloud.releaseActivity(host.id, "org", claim.id, "another-controller");
      expect((await cloud.findById(host.id))!.activity?.id).toBe(claim.id);
    } finally { finish.resolve(); await running; }
    expect((await local.findById(a.id))!.activity).toBeNull();
    expect((await cloud.findById(host.id))!.activity).toBeNull();
  });

  it("recovers a lost admission/release acknowledgement without running unconfirmed work", async () => {
    const remote = h.remote.getMockImplementation()!;
    h.remote.mockImplementation(async (...args) => {
      await remote(...args);
      throw new AppError("Connection lost", 503, "CLOUD_OFFLINE");
    });
    const work = vi.fn();
    await expect(withCloudWorkspaceActivity(a.id, work)).rejects.toMatchObject({ code: "CLOUD_OFFLINE" });
    expect(work).not.toHaveBeenCalled();
    const row = (await local.findById(a.id))!;
    expect(row.activity?.settled).toBe(true);
    h.remote.mockImplementation(remote);
    await reconcileSettledCloudActivity(row);
    expect((await local.findById(a.id))!.activity).toBeNull();
    expect((await cloud.findById(host.id))!.activity).toBeNull();
  });

  it("retains interactive admission until the terminal closes", async () => {
    const activity = await holdCloudWorkspaceActivity(a.id, "terminal");
    const terminal = { ...command, kind: "terminal" as const, terminalId: "pty-1" };
    await activity.run(async () => {
      await currentManagedCommandTracking()!.record(terminal);
    });
    expect((await local.findById(a.id))!.activity?.commands).toEqual([terminal]);
    await expect(withCloudWorkspaceActivity(host.id, vi.fn(), undefined, { lifecycle: true })).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" });
    await activity.run(() => currentManagedCommandTracking()!.complete(terminal.marker));
    await activity.release();
    expect((await cloud.findById(host.id))!.activity).toBeNull();
  });

  it("records command intent before execution and replaces it with the acknowledged task id", async () => {
    await withCloudWorkspaceActivity(a.id, async () => {
      const tracking = currentManagedCommandTracking()!;
      await tracking.record(command);
      expect((await local.findById(a.id))!.activity?.commands).toEqual([command]);
      await tracking.record({ ...command, taskId: "task-1" });
      expect((await local.findById(a.id))!.activity?.commands).toEqual([{ ...command, taskId: "task-1" }]);
      await tracking.complete(command.marker);
    });
    expect((await cloud.findById(host.id))!.activity).toBeNull();
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("attributes commands to their own host while a migration holds two managed servers", async () => {
    const second = await cloud.create({ organizationId: "org", name: "Second managed server" });
    h.repositories.set(second.id, cloud);
    h.bindings.set(second.id, "provider-vm-2");
    const otherCommand = { workspaceId: "provider-vm-2", marker: "openship-exec-other" };
    await withCloudWorkspaceActivity(host.id, () =>
      withCloudWorkspaceActivity(second.id, async () => {
        const tracking = currentManagedCommandTracking()!;
        await tracking.record(command);
        await tracking.record(otherCommand);
        expect((await cloud.findById(host.id))!.activity?.commands).toEqual([command]);
        expect((await cloud.findById(second.id))!.activity?.commands).toEqual([otherCommand]);
        await tracking.complete(command.marker);
        expect((await cloud.findById(host.id))!.activity?.commands).toEqual([]);
        expect((await cloud.findById(second.id))!.activity?.commands).toEqual([otherCommand]);
        await tracking.complete(otherCommand.marker);
      }, undefined, { scope: "migration:run" }),
    undefined, { scope: "migration:run" });
    expect((await cloud.findById(host.id))!.activity).toBeNull();
    expect((await cloud.findById(second.id))!.activity).toBeNull();
  });

  it("keeps unconfirmed children fenced even when their error is swallowed, then recovers the same scope", async () => {
    await expect(withCloudWorkspaceActivity(a.id, async () => {
      await currentManagedCommandTracking()!.record(command);
      // A caller returning successfully cannot erase a still-running command.
      return "caller swallowed a transport error";
    }, undefined, { scope: "project:a" })).rejects.toMatchObject({ code: "CLOUD_COMMAND_EXIT_UNCONFIRMED" });
    expect((await local.findById(a.id))!.activity).toMatchObject({ commands: [command] });
    expect((await local.findById(a.id))!.activity?.settled).not.toBe(true);
    const work = vi.fn(async () => "recovered");
    await expect(withCloudWorkspaceActivity(a.id, work, undefined, { scope: "project:b" })).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" });
    await expect(withCloudWorkspaceActivity(host.id, work, undefined, { lifecycle: true })).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" });
    expect(work).not.toHaveBeenCalled();
    h.recover.mockImplementation(async reference => {
      expect(reference).toEqual(command);
      expect(work).not.toHaveBeenCalled();
    });
    expect(await withCloudWorkspaceActivity(a.id, work, undefined, { scope: "project:a" })).toBe("recovered");
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
    expect((await local.findById(a.id))!.activity).toBeNull();
    expect((await cloud.findById(host.id))!.activity).toBeNull();
  });

  it("does not resume or unlock when recovery cannot confirm the interrupted command stopped", async () => {
    const activity = { id: randomUUID(), controllerId: "saas", scope: "project:a", startedAt: "2000-01-01T00:00:00Z", commands: [command] };
    await cloud.claimActivity(host.id, "org", activity);
    h.recover.mockRejectedValue(new Error("Provider is offline"));
    const work = vi.fn();
    await expect(withCloudWorkspaceActivity(host.id, work, undefined, { scope: "project:a" })).rejects.toMatchObject({ code: "CLOUD_COMMAND_EXIT_UNCONFIRMED" });
    expect(work).not.toHaveBeenCalled();
    expect((await cloud.findById(host.id))!.activity).toEqual(activity);
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it("rejects commands for another VM and late asynchronous commands after their scope ends", async () => {
    let tracking: ReturnType<typeof currentManagedCommandTracking>;
    await withCloudWorkspaceActivity(a.id, async () => {
      tracking = currentManagedCommandTracking();
      await expect(tracking!.record({ ...command, workspaceId: "another-vm" })).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
    });
    await expect(tracking!.record(command)).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_CHANGED" });
    expect((await cloud.findById(host.id))!.activity).toBeNull();
  });
});
