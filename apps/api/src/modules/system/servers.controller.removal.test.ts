import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Removing a server has to resolve the fate of everything running on it.
 *
 * The shipped behaviour was a half-deleted fleet: `project.server_id` is
 * `ON DELETE SET NULL`, but every project read coalesces the active deployment's
 * `meta.serverId` snapshot — so after the row went, a project still claimed
 * deployTarget "server" naming an id that no longer existed, and its next deploy
 * died in `resolveOrgServer` with a message that has to guess between three causes.
 * The confirm meanwhile promised only that SSH credentials would be cleared.
 *
 * What's pinned here is the ordering and the flags, because both are load-bearing:
 * every bound workload is torn down BEFORE the server row is deleted, the default
 * is `recordOnly` (rows go, containers keep running, re-importable), and any
 * failure — including a resource merely recorded as an orphan — keeps the row so
 * the operator retries. That last one is not fussiness: `reclaimOrphan` resolves
 * its transport FROM the server row, so deleting the row while an orphan exists
 * strands it forever.
 */

type Teardown = {
  ok: boolean;
  rowDeleted: boolean;
  unrecoverable: { step: string; status: "failed"; error: string }[];
  orphaned: unknown[];
};

const ok = (): Teardown => ({ ok: true, rowDeleted: true, unrecoverable: [], orphaned: [] });

const h = vi.hoisted(() => ({
  assert: vi.fn(async () => {}),
  /** Call log in order, so "row deleted last" is checkable rather than assumed. */
  calls: [] as string[],
  workloads: [] as Record<string, unknown>[],
  teardown: vi.fn(async (_ctx: unknown, id: string, _opts: unknown) => {
    h.calls.push(`teardown:${id}`);
    return ok() as Teardown;
  }),
  serverDelete: vi.fn(async (id: string) => {
    h.calls.push(`server.delete:${id}`);
  }),
  listActiveByServer: vi.fn(async () => h.workloads),
  countActiveByServer: vi.fn(async () => ({ srv1: 2 }) as Record<string, number>),
  audit: vi.fn((_event: { eventType: string; after?: unknown }) => {}),
  reachable: vi.fn(async () => ({ reachable: true })),
  mailGet: vi.fn(async () => undefined as unknown),
  tunnels: vi.fn(async () => [] as unknown[]),
  github: vi.fn(async () => undefined as unknown),
  destinations: vi.fn(async () => [] as { serverId: string }[]),
  rows: [
    {
      id: "srv1",
      name: "web-1",
      isLocal: false,
      sshHost: "203.0.113.10",
      sshPort: 22,
      sshUser: "root",
      createdAt: "2026-01-01",
    },
    {
      id: "local",
      name: "This Server",
      isLocal: true,
      sshHost: "127.0.0.1",
      sshPort: 22,
      sshUser: "root",
      createdAt: "2026-01-01",
    },
  ],
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      listByOrganization: vi.fn(async () => h.rows),
      getInOrganization: vi.fn(async (id: string) => h.rows.find((r) => r.id === id) ?? null),
      delete: h.serverDelete,
    },
    project: {
      countActiveByServer: h.countActiveByServer,
      listActiveByServer: h.listActiveByServer,
    },
    mailServer: { get: h.mailGet },
    serverTunnel: { listByServer: h.tunnels },
    serverGithubAuth: { getByServer: h.github },
    backupDestination: { listByOrganization: h.destinations },
    resourceGrant: { deleteForResource: vi.fn(async () => {}) },
  },
}));

vi.mock("@repo/adapters", () => ({ hostControlDisabled: () => false }));
vi.mock("../../lib/permission", () => ({ permission: { assert: h.assert } }));
vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
}));
vi.mock("@/lib/startup/self-server", () => ({
  ensureLocalServer: vi.fn(async () => null),
  localServerHostChannel: vi.fn(async () => null),
}));
vi.mock("@/lib/geo-ip", () => ({ primeGeo: vi.fn(async () => {}), countryForIp: () => null }));
vi.mock("../../lib/ssh-manager", () => ({
  sshManager: { invalidate: vi.fn(() => {}), diagnoseReachability: h.reachable },
}));
vi.mock("../../lib/audit", () => ({
  audit: { recordAsync: (_c: unknown, e: { eventType: string; after?: unknown }) => h.audit(e) },
  auditContextFrom: () => ({}),
}));
// The teardown is reached through a DYNAMIC import inside the handler (the static
// edge into the mail/webmail graph is a cycle risk); vi.mock intercepts it anyway.
vi.mock("../projects/project-teardown", () => ({ teardownProject: h.teardown }));

import { deleteServer, serverDeletionPreview } from "./servers.controller";

function context(id?: string, query: Record<string, string> = {}) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { param: () => id, query: (k: string) => query[k] },
    json: (payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return payload as never;
    },
  };
  return { c: c as never, sent };
}

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  slug: id,
  environmentName: "Production",
  environmentSlug: "production",
  groupId: null,
  groupName: null,
  isApp: false,
  appTemplateId: null,
  activeDeploymentId: `dep-${id}`,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.assert.mockImplementation(async () => {});
  h.teardown.mockImplementation(async (_ctx, id) => {
    h.calls.push(`teardown:${id}`);
    return ok();
  });
  h.serverDelete.mockImplementation(async (id: string) => {
    h.calls.push(`server.delete:${id}`);
  });
  h.reachable.mockImplementation(async () => ({ reachable: true }));
  h.mailGet.mockImplementation(async () => undefined);
  h.tunnels.mockImplementation(async () => []);
  h.github.mockImplementation(async () => undefined);
  h.destinations.mockImplementation(async () => []);
  h.workloads = [project("p1"), project("p2", { isApp: true, appTemplateId: "plausible" })];
});

describe("GET /servers/:id/deletion-preview", () => {
  it("lists the workloads the fleet chip counts, split into projects and apps", async () => {
    const { c, sent } = context("srv1");
    await serverDeletionPreview(c);
    const p = (sent.body as { preview: Record<string, unknown> }).preview;

    // The confirm's list and the "N projects" chip read through the same
    // coalesce fragment; listing 1 while the card says 2 is the failure mode.
    expect(p.workloads as unknown[]).toHaveLength(2);
    expect(p.projectCount).toBe(1);
    expect(p.appCount).toBe(1);
    expect(h.listActiveByServer).toHaveBeenCalledWith("org1", "srv1");
  });

  it("marks the control plane, which teardown refuses, instead of promising its removal", async () => {
    h.workloads = [project("p1", { appTemplateId: "openship" })];
    const { c, sent } = context("srv1");
    await serverDeletionPreview(c);
    const w = (sent.body as { preview: { workloads: { isControlPlane: boolean }[] } }).preview
      .workloads;
    expect(w[0]?.isControlPlane).toBe(true);
  });

  it("reports the cascades from real reads, not from copy", async () => {
    h.mailGet.mockImplementation(async () => ({ id: "srv1" }));
    h.tunnels.mockImplementation(async () => [{ id: "t1" }, { id: "t2" }]);
    h.github.mockImplementation(async () => ({ id: "g1" }));
    h.destinations.mockImplementation(async () => [{ serverId: "srv1" }, { serverId: "other" }]);

    const { c, sent } = context("srv1");
    await serverDeletionPreview(c);
    const p = (sent.body as { preview: Record<string, unknown> }).preview;
    expect(p.alsoRemoved).toEqual({ mailConfigured: true, tunnels: 2, githubRegistration: true });
    // Filtered to THIS server: an org-wide count would over-warn.
    expect(p.alsoUnbound).toEqual({ backupDestinations: 1 });
  });

  it("answers with reachable=null when the box can't be diagnosed, never a 500", async () => {
    h.reachable.mockRejectedValueOnce(new Error("ssh exploded"));
    const { c, sent } = context("srv1");
    await serverDeletionPreview(c);
    expect(sent.status).toBe(200);
    expect((sent.body as { preview: { reachable: unknown } }).preview.reachable).toBeNull();
  });

  it("tears nothing down — it is a read", async () => {
    const { c } = context("srv1");
    await serverDeletionPreview(c);
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.serverDelete).not.toHaveBeenCalled();
  });
});

describe("DELETE /servers/:id resolves every workload", () => {
  it("defaults to a control-plane-only teardown: rows go, the workload keeps running", async () => {
    const { c, sent } = context("srv1");
    await deleteServer(c);

    expect(h.teardown).toHaveBeenCalledTimes(2);
    for (const call of h.teardown.mock.calls) {
      expect(call[2]).toMatchObject({ recordOnly: true, wipeVolumes: false, force: true });
    }
    expect(sent.body).toMatchObject({ ok: true, serverRemoved: true, destroyOnSource: false });
  });

  it("deletes the server row only AFTER every workload left the control plane", async () => {
    const { c } = context("srv1");
    await deleteServer(c);
    // Row-last is what keeps a failure retryable and orphan GC able to reach the box.
    expect(h.calls).toEqual(["teardown:p1", "teardown:p2", "server.delete:srv1"]);
  });

  it("destroys on the source when asked, wiping volumes", async () => {
    const { c, sent } = context("srv1", { destroyOnSource: "true" });
    await deleteServer(c);
    for (const call of h.teardown.mock.calls) {
      expect(call[2]).toMatchObject({ recordOnly: false, wipeVolumes: true });
    }
    expect(sent.body).toMatchObject({ serverRemoved: true, destroyOnSource: true });
  });

  it("never records an orphan on the operator's behalf", async () => {
    const { c } = context("srv1", { destroyOnSource: "true" });
    await deleteServer(c);
    // `forceOrphan` would convert an undeletable resource into a row for GC — but GC
    // resolves its transport from the server row this call is about to delete, so the
    // orphan could never be reclaimed. It has to surface as a failure instead.
    for (const call of h.teardown.mock.calls) {
      expect(call[2]).not.toHaveProperty("forceOrphan", true);
    }
  });

  it("keeps the server when a teardown fails, and reports which workload", async () => {
    h.teardown.mockImplementation(async (_ctx, id) => {
      h.calls.push(`teardown:${id}`);
      if (id === "p2") {
        return {
          ok: false,
          rowDeleted: false,
          unrecoverable: [{ step: "container", status: "failed" as const, error: "still running" }],
          orphaned: [],
        };
      }
      return ok();
    });

    const { c, sent } = context("srv1");
    await deleteServer(c);

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      ok: false,
      code: "SERVER_WORKLOAD_TEARDOWN_FAILED",
      serverRemoved: false,
    });
    const body = sent.body as { workloads: { id: string; ok: boolean; error?: string }[] };
    expect(body.workloads.find((w) => w.id === "p2")).toMatchObject({
      ok: false,
      error: "still running",
    });
    // The row must survive: half a fleet deleted is the state this whole change exists
    // to prevent.
    expect(h.serverDelete).not.toHaveBeenCalled();
  });

  it("keeps the server when a workload merely left an orphan behind", async () => {
    h.teardown.mockImplementation(async (_ctx, id) => {
      h.calls.push(`teardown:${id}`);
      // `ok: true` with a recorded orphan: teardown considers itself done, GC will
      // finish the job — but only while this server row still exists.
      return { ok: true, rowDeleted: true, unrecoverable: [], orphaned: [{ kind: "container" }] };
    });

    const { c, sent } = context("srv1", { destroyOnSource: "true" });
    await deleteServer(c);

    expect(sent.status).toBe(409);
    expect(h.serverDelete).not.toHaveBeenCalled();
    expect((sent.body as { workloads: { orphaned?: number }[] }).workloads[0]?.orphaned).toBe(1);
  });

  it("treats a thrown teardown as a failure, not a crash", async () => {
    h.teardown.mockRejectedValueOnce(new Error("ssh closed"));
    const { c, sent } = context("srv1");
    await deleteServer(c);
    expect(sent.status).toBe(409);
    expect((sent.body as { workloads: { error?: string }[] }).workloads[0]?.error).toMatch(
      /ssh closed/,
    );
  });

  it("refuses the local host before touching a single workload", async () => {
    const { c, sent } = context("local");
    await deleteServer(c);
    expect(sent.status).toBe(400);
    // Ordering again: a refused removal that had already destroyed a container would
    // be the worst possible outcome of this endpoint.
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.serverDelete).not.toHaveBeenCalled();
  });

  it("tears nothing down for a caller who can't administer the server", async () => {
    h.assert.mockRejectedValueOnce(new Error("forbidden"));
    const { c } = context("srv1");
    await expect(deleteServer(c)).rejects.toThrow();
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.serverDelete).not.toHaveBeenCalled();
  });

  it("reports the control plane as refused instead of attempting it", async () => {
    h.workloads = [project("p1", { appTemplateId: "openship" })];
    const { c, sent } = context("srv1");
    await deleteServer(c);
    expect(h.teardown).not.toHaveBeenCalled();
    expect(sent.status).toBe(409);
    expect((sent.body as { workloads: { error?: string }[] }).workloads[0]?.error).toMatch(
      /control plane/i,
    );
  });

  it("audits which removal this was and what went with it", async () => {
    const { c } = context("srv1", { destroyOnSource: "true" });
    await deleteServer(c);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "server.removed",
        after: expect.objectContaining({
          destroyOnSource: true,
          workloadsRemoved: 2,
          workloadIds: ["p1", "p2"],
        }),
      }),
    );
  });

  it("audits a rejected removal too, so a kept server isn't a silent no-op", async () => {
    h.teardown.mockImplementation(async () => ({
      ok: false,
      rowDeleted: false,
      unrecoverable: [{ step: "container", status: "failed" as const, error: "nope" }],
      orphaned: [],
    }));
    const { c } = context("srv1");
    await deleteServer(c);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "server.removal.rejected" }),
    );
  });

  it("removes a server with nothing on it, as before", async () => {
    h.workloads = [];
    const { c, sent } = context("srv1");
    await deleteServer(c);
    expect(h.serverDelete).toHaveBeenCalledWith("srv1");
    expect(sent.body).toMatchObject({ ok: true, serverRemoved: true, removed: 0 });
  });
});
