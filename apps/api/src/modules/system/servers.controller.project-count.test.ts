import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `projectCount` is one field with one meaning, and BOTH server reads must carry it.
 *
 * The detail view spends it on two decisions the list already makes: whether an
 * absent edge is an issue or merely an offer, and how many workloads "Remove server"
 * is about to take with it. The second one is why `deleteServer` no longer reports an
 * `unboundProjects` count: every bound workload is now torn down before the row goes,
 * so nothing is left unbound, and the number the confirm needs has to come from a read
 * — this field, and the itemised `GET /servers/:id/deletion-preview` beside it. So what
 * is pinned here is that `GET /servers/:id` reports the SAME number under the SAME key as
 * `GET /servers`, since a detail page reading a second name (or a silent absence
 * that a `?? 0` fallback turns into "no projects here") would quietly disagree with
 * the fleet view about whether this box hosts anything.
 */

const h = vi.hoisted(() => ({
  assert: vi.fn(async () => {}),
  counts: vi.fn(async () => ({ srv1: 3, srv2: 1 }) as Record<string, number>),
  rows: [
    { id: "srv1", name: "web-1", isLocal: false, sshHost: "203.0.113.10", sshPort: 22, sshUser: "root", createdAt: "2026-01-01" },
    { id: "srv2", name: "web-2", isLocal: false, sshHost: "203.0.113.11", sshPort: 22, sshUser: "root", createdAt: "2026-01-01" },
    { id: "srv3", name: "web-3", isLocal: false, sshHost: "203.0.113.12", sshPort: 22, sshUser: "root", createdAt: "2026-01-01" },
  ],
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      listByOrganization: vi.fn(async () => h.rows),
      getInOrganization: vi.fn(async (id: string) => h.rows.find((r) => r.id === id) ?? null),
    },
    project: { countActiveByServer: h.counts },
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

import { getServer, listServers } from "./servers.controller";

/** Enough of a Hono context for these two handlers: a path param in, JSON out. */
function context(id?: string) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { param: () => id },
    json: (payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return payload as never;
    },
  };
  return { c: c as never, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assert.mockImplementation(async () => {});
  h.counts.mockImplementation(async () => ({ srv1: 3, srv2: 1 }));
});

describe("GET /servers/:id carries projectCount", () => {
  it("reports the same key and number the list reports for that server", async () => {
    const list = context();
    await listServers(list.c);
    const fromList = (list.sent.body as { id: string; projectCount: number }[]).find(
      (s) => s.id === "srv1",
    );

    const one = context("srv1");
    await getServer(one.c);
    const detail = one.sent.body as Record<string, unknown>;

    expect(fromList?.projectCount).toBe(3);
    // `toHaveProperty` rather than a truthy check: an ABSENT field is exactly the
    // bug — the client's `?? 0` fallback makes it indistinguishable from a real 0.
    expect(detail).toHaveProperty("projectCount", 3);
  });

  it("reports 0 for a server hosting nothing, without inventing a second field", async () => {
    const { c, sent } = context("srv3");
    await getServer(c);
    const detail = sent.body as Record<string, unknown>;
    expect(detail.projectCount).toBe(0);
    // One field, one meaning: no `projects`/`activeProjects`/`projectsCount` alias.
    expect(Object.keys(detail).filter((k) => /project/i.test(k))).toEqual(["projectCount"]);
  });

  it("still answers, with 0, when the count query fails", async () => {
    h.counts.mockRejectedValueOnce(new Error("db down"));
    const { c, sent } = context("srv1");
    await getServer(c);
    expect(sent.status).toBe(200);
    expect(sent.body).toHaveProperty("projectCount", 0);
  });

  it("does not count for a server the caller can't read", async () => {
    h.assert.mockRejectedValueOnce(new Error("forbidden"));
    const { c } = context("srv1");
    await expect(getServer(c)).rejects.toThrow();
    expect(h.counts).not.toHaveBeenCalled();
  });
});
