/**
 * Monitors HTTP E2E — real router + real auth + real permission + real DB.
 *
 * Covers: auth rejection, monitor create/list/patch/delete round-trip with
 * `repos` persistence assertions, TypeBox validation rejections (non-http URL,
 * interval below 30s), and cross-org isolation — another org's owner gets 404,
 * never existence-leaking.
 */
import { describe, it, expect } from "vitest";
import { makeApp, seedOwner, seedProject, req, repos } from "./_harness";

const app = makeApp();

describe("monitors HTTP — auth + CRUD", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await req(app, "GET", "/proj_x/monitors")).status).toBe(401);
    expect(
      (await req(app, "POST", "/proj_x/monitors", { body: { name: "x", url: "http://a" } })).status,
    ).toBe(401);
  });

  it("owner create/list/patch/delete round-trip persists via repos", async () => {
    const o = await seedOwner();
    const projectId = await seedProject(o.orgId);

    const create = await req(app, "POST", `/${projectId}/monitors`, {
      auth: o.auth,
      body: { name: "API health", url: "http://127.0.0.1:9/health", intervalSeconds: 30 },
    });
    expect(create.status).toBe(201);
    const monitorId: string = create.body.data.id;
    expect(monitorId).toMatch(/^mon_/);

    // persisted for real, with defaults applied
    let row = await repos.monitor.findById(monitorId);
    expect(row?.projectId).toBe(projectId);
    expect(row?.organizationId).toBe(o.orgId);
    expect(row?.url).toBe("http://127.0.0.1:9/health");
    expect(row?.intervalSeconds).toBe(30);
    expect(row?.timeoutMs).toBe(10_000);
    expect(row?.failureThreshold).toBe(3);
    expect(row?.status).toBe("unknown");

    // listed with the uptime read model (null — no checks yet)
    const list = await req(app, "GET", `/${projectId}/monitors`, { auth: o.auth });
    expect(list.status).toBe(200);
    const listed = list.body.data.find((m: { id: string }) => m.id === monitorId);
    expect(listed).toBeDefined();
    expect(listed.uptime24h).toBeNull();

    // patch fields + disable
    const patch = await req(app, "PATCH", `/${projectId}/monitors/${monitorId}`, {
      auth: o.auth,
      body: { name: "API health v2", failureThreshold: 5, enabled: false },
    });
    expect(patch.status).toBe(200);
    row = await repos.monitor.findById(monitorId);
    expect(row?.name).toBe("API health v2");
    expect(row?.failureThreshold).toBe(5);
    expect(row?.enabled).toBe(false);

    // delete removes the row
    const del = await req(app, "DELETE", `/${projectId}/monitors/${monitorId}`, { auth: o.auth });
    expect(del.status).toBe(200);
    expect(await repos.monitor.findById(monitorId)).toBeUndefined();
  });

  it("rejects invalid bodies with 400", async () => {
    const o = await seedOwner();
    const projectId = await seedProject(o.orgId);

    // non-http(s) URL
    expect(
      (
        await req(app, "POST", `/${projectId}/monitors`, {
          auth: o.auth,
          body: { name: "ftp", url: "ftp://files.local" },
        })
      ).status,
    ).toBe(400);

    // interval below the 30s floor
    expect(
      (
        await req(app, "POST", `/${projectId}/monitors`, {
          auth: o.auth,
          body: { name: "fast", url: "http://a.local", intervalSeconds: 10 },
        })
      ).status,
    ).toBe(400);

    // nothing was created
    const list = await req(app, "GET", `/${projectId}/monitors`, { auth: o.auth });
    expect(list.body.data.length).toBe(0);
  });
});

describe("monitors HTTP — cross-org isolation", () => {
  it("another org's owner gets 404 for the project's monitors", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const projectA = await seedProject(a.orgId);
    const monitorId: string = (
      await req(app, "POST", `/${projectA}/monitors`, {
        auth: a.auth,
        body: { name: "secret", url: "http://internal.local/health" },
      })
    ).body.data.id;

    // owner B (different org) is denied — 404, not existence-leaking
    expect((await req(app, "GET", `/${projectA}/monitors`, { auth: b.auth })).status).toBe(404);
    expect(
      (
        await req(app, "POST", `/${projectA}/monitors`, {
          auth: b.auth,
          body: { name: "evil", url: "http://evil.local" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(app, "PATCH", `/${projectA}/monitors/${monitorId}`, {
          auth: b.auth,
          body: { enabled: false },
        })
      ).status,
    ).toBe(404);
    expect(
      (await req(app, "DELETE", `/${projectA}/monitors/${monitorId}`, { auth: b.auth })).status,
    ).toBe(404);

    // nothing changed for owner A
    const row = await repos.monitor.findById(monitorId);
    expect(row?.enabled).toBe(true);
  });
});
