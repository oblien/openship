import { describe, expect, it } from "vitest";
import {
  makeApp,
  repos,
  req,
  seedEvent,
  seedMember,
  seedOwner,
  seedScopedToken,
  setOrgRetentionMetadata,
} from "./_harness";
import type { SeededOwner } from "./_harness";
import { pruneAuditEvents } from "../../../src/modules/audit/audit-prune";

/**
 * The recording switch: an organization can stop keeping an activity record.
 *
 * Two properties carry the weight here.
 *
 * The gate lives in the REPO, not in `lib/audit.ts`, because four writers
 * (cloud sessions, cloud github, incidents, the billing cron) call
 * `repos.auditEvent.create` directly and would otherwise keep writing after the
 * switch was flipped. So the test asserts on the repo, not on the helper.
 *
 * And switching recording off is the one change whose own audit row the gate
 * would eat: written after the flip it is dropped, and the log then ends with no
 * explanation of why it ends. The route writes it while recording is still on;
 * these tests pin that ordering, since nothing about the code reads as
 * order-dependent at a glance.
 */

const app = makeApp();

/** Rows of one type in an org, so a gate assertion can't be fooled by ordering. */
async function countOf(orgId: string, eventType: string): Promise<number> {
  const { total } = await repos.auditEvent.listByOrganization(orgId, {
    eventType,
    page: 1,
    perPage: 200,
  });
  return total;
}

async function totalRows(orgId: string): Promise<number> {
  const { total } = await repos.auditEvent.listByOrganization(orgId, { page: 1, perPage: 200 });
  return total;
}

describe("defaults — recording is ON before anyone touches it", () => {
  it("reports enabled with 90-day retention for an org with no row", async () => {
    const org = await seedOwner();
    const res = await req(app, "GET", "/settings", { auth: org.auth });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, retentionDays: 90, canManage: true });
  });

  it("records events for an org that has never opened the settings", async () => {
    const org = await seedOwner();
    const row = await repos.auditEvent.create({
      organizationId: org.orgId,
      eventType: "project.created",
    });
    expect(row).not.toBeNull();
  });

  it("distinguishes 'no row' from 'defaults' — the prune needs to know", async () => {
    // `get` folds a missing row into the defaults, so only `find` can tell the
    // prune whether the legacy organization.metadata value still applies.
    const org = await seedOwner();
    expect(await repos.auditSettings.find(org.orgId)).toBeUndefined();
    expect(await repos.auditSettings.get(org.orgId)).toEqual({ enabled: true, retentionDays: 90 });
    await repos.auditSettings.upsert(org.orgId, { retentionDays: 30 });
    expect(await repos.auditSettings.find(org.orgId)).toMatchObject({ retentionDays: 30 });
  });
});

describe("who may change it", () => {
  it("lets an owner and an admin manage it", async () => {
    const org = await seedOwner();
    const admin = await seedMember(org.orgId, "admin", "Admin");
    const res = await req(app, "PATCH", "/settings", {
      auth: admin.auth,
      body: { retentionDays: 180 },
    });
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(180);
  });

  it("hides the audit log from a plain member entirely", async () => {
    // `roleAllowsResourceType` denies members the `audit` resource, so the tab
    // isn't a "read but not write" case for them — it's not visible at all.
    //
    // 404, not 403: `permission.assert` denies by throwing NotFoundError so an
    // out-of-permission resource doesn't confirm its own existence.
    const org = await seedOwner();
    const member = await seedMember(org.orgId, "member", "Member");
    expect((await req(app, "GET", "/settings", { auth: member.auth })).status).toBe(404);
    expect((await req(app, "GET", "/", { auth: member.auth })).status).toBe(404);
    expect(
      (await req(app, "PATCH", "/settings", { auth: member.auth, body: { enabled: false } })).status,
    ).toBe(404);
  });

  it("shows a read-only principal the settings but refuses the write", async () => {
    // This is what canManage exists for: the UI renders the switch disabled
    // rather than offering a control that 403s on click.
    const org = await seedOwner();
    const readOnly = await seedScopedToken(org, [
      { resourceType: "audit", resourceId: "*", permissions: ["read"] },
    ]);
    const res = await req(app, "GET", "/settings", { auth: readOnly.auth });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, canManage: false });

    const facets = await req(app, "GET", "/facets", { auth: readOnly.auth });
    expect(facets.body.canManage).toBe(false);

    const patch = await req(app, "PATCH", "/settings", {
      auth: readOnly.auth,
      body: { enabled: false },
    });
    expect(patch.status).toBe(404); // deny is IDOR-safe, see above
    expect(await repos.auditSettings.get(org.orgId)).toMatchObject({ enabled: true });
  });
});

describe("validation", () => {
  let org: SeededOwner;
  const patch = async (body: unknown) => req(app, "PATCH", "/settings", { auth: org.auth, body });

  it("accepts only the retention windows the UI offers", async () => {
    org = await seedOwner();
    for (const days of [7, 30, 90, 180, 365]) {
      const res = await patch({ retentionDays: days });
      expect(res.status, `retentionDays=${days}`).toBe(200);
      expect(res.body.retentionDays).toBe(days);
    }
    for (const days of [0, 1, 45, 3650, -90]) {
      const res = await patch({ retentionDays: days });
      expect(res.status, `retentionDays=${days}`).toBe(400);
    }
  });

  it("rejects an empty patch instead of recording a no-op change", async () => {
    org = await seedOwner();
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Nothing to update");
    expect(await countOf(org.orgId, "audit.retention_changed")).toBe(0);
  });

  it("does not read a truthy string as a boolean", async () => {
    // `{ enabled: "false" }` from a hand-rolled client must not disable
    // recording, and `"true"` must not silently count as a change either.
    org = await seedOwner();
    expect((await patch({ enabled: "false" })).status).toBe(400);
    expect(await repos.auditSettings.get(org.orgId)).toMatchObject({ enabled: true });
  });
});

describe("turning recording off", () => {
  it("writes the row explaining the change BEFORE the flip", async () => {
    const org = await seedOwner();
    const res = await req(app, "PATCH", "/settings", {
      auth: org.auth,
      body: { enabled: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    // The whole point: the log's last row says who ended it.
    const { rows } = await repos.auditEvent.listByOrganization(org.orgId, { page: 1, perPage: 10 });
    expect(rows[0]).toMatchObject({
      eventType: "audit.disabled",
      actorUserId: org.userId,
      resourceType: "audit",
      after: { enabled: false },
    });
  });

  it("attributes the change to the surface it came from", async () => {
    const org = await seedOwner();
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: false } });
    const { rows } = await repos.auditEvent.listByOrganization(org.orgId, { page: 1, perPage: 10 });
    // A PAT with no CLI user agent is a plain API call — not "dashboard", which
    // would be the wrong story for a scripted change.
    expect(rows[0]!.source).toBe("api");
  });

  it("stops recording every writer, including the ones that bypass lib/audit", async () => {
    const org = await seedOwner();
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: false } });
    const before = await totalRows(org.orgId);

    // The direct-repo path used by incidents, cloud sessions and the billing cron.
    const row = await repos.auditEvent.create({
      organizationId: org.orgId,
      eventType: "deployment.succeeded",
    });
    expect(row).toBeNull(); // incident.service reads `row?.id` off this
    expect(await totalRows(org.orgId)).toBe(before);
  });

  it("keeps the rows already written and still serves them", async () => {
    const org = await seedOwner();
    await seedEvent({ organizationId: org.orgId, eventType: "domain.added" });
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: false } });
    const feed = await req(app, "GET", "/", { auth: org.auth });
    expect(feed.status).toBe(200);
    expect(feed.body.data.map((r: { eventType: string }) => r.eventType)).toContain("domain.added");
  });

  it("switches off one org only", async () => {
    const off = await seedOwner();
    const on = await seedOwner();
    await req(app, "PATCH", "/settings", { auth: off.auth, body: { enabled: false } });
    expect(await repos.auditEvent.create({ organizationId: off.orgId, eventType: "x.y" })).toBeNull();
    expect(
      await repos.auditEvent.create({ organizationId: on.orgId, eventType: "x.y" }),
    ).not.toBeNull();
  });

  it("takes effect immediately despite the isEnabled memo", async () => {
    // The gate is memoized for 30s on the hot path. A toggle in the UI has to be
    // visible on the next write, not half a minute later.
    const org = await seedOwner();
    expect(await repos.auditSettings.isEnabled(org.orgId)).toBe(true); // populates the memo
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: false } });
    expect(await repos.auditSettings.isEnabled(org.orgId)).toBe(false);
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: true } });
    expect(await repos.auditSettings.isEnabled(org.orgId)).toBe(true);
  });
});

describe("turning it back on", () => {
  it("records the re-enable and resumes writing", async () => {
    const org = await seedOwner();
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: false } });
    const res = await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: true } });
    expect(res.body.enabled).toBe(true);

    const { rows } = await repos.auditEvent.listByOrganization(org.orgId, { page: 1, perPage: 10 });
    const types = rows.map((r) => r.eventType);
    expect(types).toContain("audit.enabled");
    expect(types).toContain("audit.disabled");
    expect(
      await repos.auditEvent.create({ organizationId: org.orgId, eventType: "project.created" }),
    ).not.toBeNull();
  });

  it("does not re-record a switch that was already in that position", async () => {
    const org = await seedOwner();
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: true } });
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { enabled: true } });
    expect(await countOf(org.orgId, "audit.enabled")).toBe(0);
  });
});

describe("retention changes", () => {
  it("records the before and after", async () => {
    const org = await seedOwner();
    const res = await req(app, "PATCH", "/settings", {
      auth: org.auth,
      body: { retentionDays: 365 },
    });
    expect(res.status).toBe(200);
    const { rows } = await repos.auditEvent.listByOrganization(org.orgId, {
      eventType: "audit.retention_changed",
      page: 1,
      perPage: 10,
    });
    expect(rows[0]).toMatchObject({ before: { retentionDays: 90 }, after: { retentionDays: 365 } });
  });

  it("stays silent when the value did not move", async () => {
    const org = await seedOwner();
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { retentionDays: 90 } });
    expect(await countOf(org.orgId, "audit.retention_changed")).toBe(0);
  });

  it("survives being bundled with the switch going off", async () => {
    // Both rows have to be written before the flip, or the retention change is
    // the one thing the log loses on the way out.
    const org = await seedOwner();
    const res = await req(app, "PATCH", "/settings", {
      auth: org.auth,
      body: { enabled: false, retentionDays: 30 },
    });
    expect(res.body).toMatchObject({ enabled: false, retentionDays: 30 });
    expect(await countOf(org.orgId, "audit.disabled")).toBe(1);
    expect(await countOf(org.orgId, "audit.retention_changed")).toBe(1);
  });

  it("survives being bundled with the switch coming back on", async () => {
    const org = await seedOwner();
    await repos.auditSettings.upsert(org.orgId, { enabled: false });
    const res = await req(app, "PATCH", "/settings", {
      auth: org.auth,
      body: { enabled: true, retentionDays: 7 },
    });
    expect(res.body).toMatchObject({ enabled: true, retentionDays: 7 });
    expect(await countOf(org.orgId, "audit.enabled")).toBe(1);
    expect(await countOf(org.orgId, "audit.retention_changed")).toBe(1);
  });

  it("records nothing while recording is off", async () => {
    const org = await seedOwner();
    await repos.auditSettings.upsert(org.orgId, { enabled: false });
    await req(app, "PATCH", "/settings", { auth: org.auth, body: { retentionDays: 180 } });
    expect(await repos.auditSettings.get(org.orgId)).toMatchObject({ retentionDays: 180 });
    expect(await countOf(org.orgId, "audit.retention_changed")).toBe(0);
  });
});

describe("the prune reads the new setting first", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("prefers audit_settings over the pre-0088 organization.metadata value", async () => {
    const org = await seedOwner();
    await setOrgRetentionMetadata(org.orgId, 1); // legacy: keep one day
    await repos.auditSettings.upsert(org.orgId, { retentionDays: 365 });
    await seedEvent({
      organizationId: org.orgId,
      eventType: "deployment.succeeded",
      createdAt: new Date(Date.now() - 100 * DAY),
    });

    await pruneAuditEvents();
    expect(await totalRows(org.orgId)).toBe(1);
  });

  it("still honours organization.metadata when the org never saved settings", async () => {
    const org = await seedOwner();
    await setOrgRetentionMetadata(org.orgId, 1);
    await seedEvent({
      organizationId: org.orgId,
      eventType: "deployment.succeeded",
      createdAt: new Date(Date.now() - 5 * DAY),
    });

    await pruneAuditEvents();
    expect(await totalRows(org.orgId)).toBe(0);
  });

  it("prunes even while recording is off — the switch governs new rows only", async () => {
    const org = await seedOwner();
    await repos.auditSettings.upsert(org.orgId, { enabled: false, retentionDays: 7 });
    await seedEvent({
      organizationId: org.orgId,
      eventType: "deployment.succeeded",
      createdAt: new Date(Date.now() - 30 * DAY),
    });
    const fresh = await seedEvent({ organizationId: org.orgId, eventType: "domain.added" });

    await pruneAuditEvents();
    const { rows } = await repos.auditEvent.listByOrganization(org.orgId, { page: 1, perPage: 10 });
    expect(rows.map((r) => r.id)).toEqual([fresh]);
  });
});
