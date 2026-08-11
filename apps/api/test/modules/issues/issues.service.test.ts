import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The global issue feed: five existing readers merged into one worst-first list.
 *
 * It adds no detection, so what can actually regress here is the merge itself:
 *
 *   1. ONE severity ordering. Every source maps into `SEVERITY_RANK`; if one
 *      starts re-judging its own rows, an outage sorts below an advisory and the
 *      list stops being scannable.
 *   2. ONE row per cause. A box we can't reach makes its cached edge/mail rows
 *      meaningless, and "an update is available" for a container that isn't
 *      running is noise under the row saying it isn't running. Both suppressions
 *      are load-bearing — without them a single dead box paints the whole feed.
 *   3. The infra gate. Incidents and managed components are `server:read` +
 *      self-hosted. A member without server access, or any caller on cloud, must
 *      get the deploy/domain/update rows and no hint that servers exist.
 *   4. The fix travels WITH the row. `resolveWith` (an HTTP call) or `infraFix`
 *      (a modal flow) — and the two rows that deliberately carry neither (a
 *      recovering incident, self-update) must not grow a button that 403s.
 */

const {
  incidentListByOrg,
  listBehindByOrg,
  projectListByOrganization,
  serverListByOrganization,
} = vi.hoisted(() => ({
  incidentListByOrg: vi.fn(),
  listBehindByOrg: vi.fn(),
  projectListByOrganization: vi.fn(),
  serverListByOrganization: vi.fn(),
}));
const { envMock } = vi.hoisted(() => ({ envMock: { CLOUD_MODE: false } as { CLOUD_MODE: boolean } }));
const { checkPermissionOnResource } = vi.hoisted(() => ({ checkPermissionOnResource: vi.fn() }));
const { loadOrgContainerIssues } = vi.hoisted(() => ({ loadOrgContainerIssues: vi.fn() }));
const { listOrganizationUpdates } = vi.hoisted(() => ({ listOrganizationUpdates: vi.fn() }));
const { getOrgPendingActions } = vi.hoisted(() => ({ getOrgPendingActions: vi.fn() }));

vi.mock("@repo/db", () => ({
  repos: {
    serviceIncident: { listByOrg: incidentListByOrg },
    serverContainerStatus: { listBehindByOrg: listBehindByOrg },
    project: { listByOrganization: projectListByOrganization },
    server: { listByOrganization: serverListByOrganization },
  },
}));
vi.mock("../../../src/config/env", () => ({ env: envMock }));
vi.mock("../../../src/lib/permission", () => ({ checkPermissionOnResource }));
vi.mock("../../../src/modules/system/server-containers.service", () => ({ loadOrgContainerIssues }));
vi.mock("../../../src/modules/updates/updates.service", () => ({ listOrganizationUpdates }));
vi.mock("../../../src/modules/projects/pending-actions.service", () => ({ getOrgPendingActions }));

import { countIssues, listOrganizationIssues } from "../../../src/modules/issues/issues.service";
import type { RequestContext } from "../../../src/lib/request-context";

const ORG = "org-1";
const ctx = { userId: "user-1", organizationId: ORG } as RequestContext;

const incident = (over: Record<string, unknown> = {}) => ({
  id: "inc-1",
  organizationId: ORG,
  projectId: "proj-1",
  serverId: "srv-1",
  serviceKey: "proj-1:web",
  serviceName: "storefront-web",
  kind: "down",
  status: "open",
  reason: "Exited with code 137",
  exitCode: 137,
  restartCount: 0,
  oomKilled: true,
  confirmations: 2,
  logExcerpt: null,
  openedAt: new Date("2026-08-01T10:00:00.000Z"),
  resolvedAt: null,
  ...over,
});

const component = (over: Record<string, unknown> = {}) => ({
  server: { id: "srv-1", name: "web-01" },
  component: "edge",
  issue: "down",
  containerMissing: false,
  reason: "nginx: [emerg] bind() to 0.0.0.0:443 failed",
  ...over,
});

const pendingAction = (over: Record<string, unknown> = {}) => ({
  id: "domain:dom-1:unverified",
  kind: "domain_unverified",
  severity: "action_required",
  title: "app.example.com is not verified",
  message: "DNS does not resolve to this server",
  details: { hostname: "app.example.com", verifyAttempts: 3 },
  resolveWith: [{ label: "Verify", method: "POST", path: "/api/domains/dom-1/verify" }],
  ...over,
});

const update = (over: Record<string, unknown> = {}) => ({
  projectId: "proj-2",
  name: "plausible",
  appTemplateId: "plausible",
  kind: "image",
  behind: true,
  latestInProgress: false,
  currentLabel: "2.1.0",
  latestLabel: "2.1.4",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CLOUD_MODE = false;
  checkPermissionOnResource.mockResolvedValue(true);
  incidentListByOrg.mockResolvedValue([]);
  listBehindByOrg.mockResolvedValue([]);
  loadOrgContainerIssues.mockResolvedValue({ total: 0, servers: [], edgeDown: 0, edgeMissing: 0, mailDown: 0 });
  listOrganizationUpdates.mockResolvedValue([]);
  getOrgPendingActions.mockResolvedValue(new Map());
  projectListByOrganization.mockResolvedValue({
    rows: [
      { id: "proj-1", name: "storefront" },
      { id: "proj-2", name: "plausible" },
    ],
  });
  serverListByOrganization.mockResolvedValue([{ id: "srv-1", name: "web-01", sshHost: "10.0.0.4" }]);
});

describe("severity is defined once, across all sources", () => {
  it("sorts outage before action-required before advisory", async () => {
    incidentListByOrg.mockResolvedValue([
      incident({ id: "inc-unhealthy", kind: "unhealthy", serviceName: "checkout" }),
      incident({ id: "inc-down", kind: "down" }),
    ]);
    getOrgPendingActions.mockResolvedValue(
      new Map([
        [
          "proj-1",
          [
            pendingAction({ id: "port:8080", kind: "port_advisory", severity: "advisory" }),
            pendingAction(),
          ],
        ],
      ]),
    );
    listOrganizationUpdates.mockResolvedValue([update()]);

    const { issues, counts } = await listOrganizationIssues(ctx);

    expect(issues.map((i) => i.severity)).toEqual([
      "outage",
      "action_required",
      "action_required",
      "advisory",
      "advisory",
    ]);
    expect(counts).toEqual({ outage: 1, actionRequired: 2, advisory: 2, total: 5 });
  });

  it("does not call a failing healthcheck an outage", async () => {
    // A container that is up and answering while its healthcheck fails is
    // degraded, not offline. Promoting it is how an outage list stops being read.
    incidentListByOrg.mockResolvedValue([incident({ kind: "unhealthy" })]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].kind).toBe("workload_unhealthy");
    expect(issues[0].severity).toBe("action_required");
  });

  it("keeps an uninstalled edge out of the outage tier", async () => {
    loadOrgContainerIssues.mockResolvedValue({
      total: 1,
      servers: [component({ issue: "absent", reason: undefined })],
      edgeDown: 0,
      edgeMissing: 1,
      mailDown: 0,
    });

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].kind).toBe("edge_absent");
    expect(issues[0].severity).toBe("action_required");
  });

  it("counts an empty feed as zero of everything", () => {
    expect(countIssues([])).toEqual({ outage: 0, actionRequired: 0, advisory: 0, total: 0 });
  });
});

describe("one row per cause", () => {
  it("reports an unreachable box once, not once per workload on it", async () => {
    incidentListByOrg.mockResolvedValue([
      incident({
        id: "inc-box",
        kind: "server_unreachable",
        projectId: null,
        serviceKey: "server:srv-1",
        serviceName: "web-01",
        reason: "ssh: connect: connection refused",
      }),
    ]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "server_unreachable",
      scope: "server",
      severity: "outage",
      target: { scope: "server", id: "srv-1", name: "web-01", href: "/servers/srv-1" },
    });
  });

  it("suppresses cached component rows for a box we cannot reach", async () => {
    // The edge row is the last thing we SAW, not what's true now. Printing
    // "edge down" beside "server unreachable" is two rows for one cause, and
    // only one of them is actionable.
    incidentListByOrg.mockResolvedValue([
      incident({ id: "inc-box", kind: "server_unreachable", projectId: null, serviceName: "web-01" }),
    ]);
    loadOrgContainerIssues.mockResolvedValue({
      total: 1,
      servers: [component()],
      edgeDown: 1,
      edgeMissing: 0,
      mailDown: 0,
    });
    listBehindByOrg.mockResolvedValue([
      { serverId: "srv-1", component: "mail", runningVersion: "0.4.1", pinnedVersion: "0.5.0", latestInProgress: false },
    ]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues.map((i) => i.kind)).toEqual(["server_unreachable"]);
  });

  it("does not offer an update for a component that is down", async () => {
    loadOrgContainerIssues.mockResolvedValue({
      total: 1,
      servers: [component()],
      edgeDown: 1,
      edgeMissing: 0,
      mailDown: 0,
    });
    listBehindByOrg.mockResolvedValue([
      { serverId: "srv-1", component: "edge", runningVersion: "0.4.1", pinnedVersion: "0.5.0", latestInProgress: false },
      { serverId: "srv-1", component: "mail", runningVersion: "0.4.1", pinnedVersion: "0.5.0", latestInProgress: false },
    ]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues.map((i) => i.kind)).toEqual(["edge_down", "component_behind"]);
    expect(issues[1].details).toMatchObject({ component: "mail" });
  });
});

describe("the infra gate mirrors the endpoints it replaces", () => {
  it("drops incidents and components for a member without server:read", async () => {
    checkPermissionOnResource.mockResolvedValue(false);
    incidentListByOrg.mockResolvedValue([incident()]);
    loadOrgContainerIssues.mockResolvedValue({
      total: 1,
      servers: [component()],
      edgeDown: 1,
      edgeMissing: 0,
      mailDown: 0,
    });
    listBehindByOrg.mockResolvedValue([
      { serverId: "srv-1", component: "edge", runningVersion: "0.4.1", pinnedVersion: "0.5.0", latestInProgress: false },
    ]);
    getOrgPendingActions.mockResolvedValue(new Map([["proj-1", [pendingAction()]]]));
    listOrganizationUpdates.mockResolvedValue([update()]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues.map((i) => i.source)).toEqual(["domain", "update"]);
    expect(incidentListByOrg).not.toHaveBeenCalled();
    expect(loadOrgContainerIssues).not.toHaveBeenCalled();
    expect(listBehindByOrg).not.toHaveBeenCalled();
  });

  it("drops them on cloud without asking about permissions at all", async () => {
    // Managed containers and the health watcher are self-hosted concepts; the
    // endpoints behind them `assertNotCloud`, so the feed must not call them.
    envMock.CLOUD_MODE = true;
    incidentListByOrg.mockResolvedValue([incident()]);
    getOrgPendingActions.mockResolvedValue(new Map([["proj-1", [pendingAction()]]]));

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues.map((i) => i.source)).toEqual(["domain"]);
    expect(checkPermissionOnResource).not.toHaveBeenCalled();
    expect(loadOrgContainerIssues).not.toHaveBeenCalled();
  });

  it("checks server:read as a list-scope read, not against one server", async () => {
    await listOrganizationIssues(ctx);

    expect(checkPermissionOnResource).toHaveBeenCalledWith(ctx, {
      resourceType: "server",
      resourceId: "*",
      action: "read",
      scope: "list",
    });
  });

  it("returns an empty resolved tab rather than leaking history past the gate", async () => {
    checkPermissionOnResource.mockResolvedValue(false);
    incidentListByOrg.mockResolvedValue([incident({ status: "resolved" })]);

    const { issues, counts } = await listOrganizationIssues(ctx, { status: "resolved" });

    expect(issues).toEqual([]);
    expect(counts.total).toBe(0);
    expect(incidentListByOrg).not.toHaveBeenCalled();
  });
});

describe("history is incidents only", () => {
  it("returns resolved incidents with both ends of the clock", async () => {
    incidentListByOrg.mockResolvedValue([
      incident({
        status: "resolved",
        resolvedAt: new Date("2026-08-01T10:12:00.000Z"),
      }),
    ]);

    const { issues } = await listOrganizationIssues(ctx, { status: "resolved" });

    expect(incidentListByOrg).toHaveBeenCalledWith(ORG, { status: "resolved" });
    expect(issues[0]).toMatchObject({
      since: "2026-08-01T10:00:00.000Z",
      resolvedAt: "2026-08-01T10:12:00.000Z",
    });
  });

  it("asks no other source for history", async () => {
    incidentListByOrg.mockResolvedValue([]);

    await listOrganizationIssues(ctx, { status: "resolved" });

    expect(getOrgPendingActions).not.toHaveBeenCalled();
    expect(listOrganizationUpdates).not.toHaveBeenCalled();
    expect(loadOrgContainerIssues).not.toHaveBeenCalled();
  });

  it("leaves resolvedAt absent on an open incident, so no clock reads as stopped", async () => {
    incidentListByOrg.mockResolvedValue([incident()]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].since).toBe("2026-08-01T10:00:00.000Z");
    expect(issues[0].resolvedAt).toBeUndefined();
  });
});

describe("every row carries its own fix", () => {
  it("sends a stopped component through the infra dispatcher, not an HTTP call", async () => {
    loadOrgContainerIssues.mockResolvedValue({
      total: 1,
      servers: [component()],
      edgeDown: 1,
      edgeMissing: 0,
      mailDown: 0,
    });

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0]).toMatchObject({
      id: "component:srv-1:edge",
      title: "web-01",
      resolveWith: [],
      infraFix: { serverId: "srv-1", component: "edge", action: "repair" },
      target: { href: "/servers/srv-1?tab=components" },
    });
    // The component's own error, not a generic "is down" — it names the cause.
    expect(issues[0].message).toContain("bind() to 0.0.0.0:443 failed");
  });

  it("points a VANISHED mail container at setup instead of offering a repair", async () => {
    // Recreating it needs the secrets only the mail wizard holds; a one-click
    // repair here would clobber a live mailbox.
    loadOrgContainerIssues.mockResolvedValue({
      total: 1,
      servers: [component({ component: "mail", containerMissing: true, reason: undefined })],
      edgeDown: 0,
      edgeMissing: 0,
      mailDown: 1,
    });

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].kind).toBe("mail_down");
    expect(issues[0].infraFix).toBeUndefined();
    expect(issues[0].target.href).toBe("/emails");
  });

  it("reuses the same dispatcher for drift, with update instead of repair", async () => {
    listBehindByOrg.mockResolvedValue([
      { serverId: "srv-1", component: "edge", runningVersion: "0.4.1", pinnedVersion: "0.5.0", latestInProgress: false },
    ]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0]).toMatchObject({
      kind: "component_behind",
      severity: "advisory",
      title: "web-01",
      message: "0.4.1 → 0.5.0",
      infraFix: { serverId: "srv-1", component: "edge", action: "update" },
    });
  });

  it("offers no resolution for an incident, because nothing single-call recovers one", async () => {
    incidentListByOrg.mockResolvedValue([incident({ kind: "crash_loop" })]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0]).toMatchObject({
      kind: "workload_crash_loop",
      severity: "outage",
      resolveWith: [],
      target: { scope: "project", name: "storefront", href: "/projects/proj-1/health" },
    });
    expect(issues[0].infraFix).toBeUndefined();
  });

  it("passes a pending action's resolution through untouched", async () => {
    getOrgPendingActions.mockResolvedValue(new Map([["proj-1", [pendingAction()]]]));

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].resolveWith).toEqual([
      { label: "Verify", method: "POST", path: "/api/domains/dom-1/verify" },
    ]);
  });

  it("gives the control plane's own update no in-app button", async () => {
    // `build.service` refuses to redeploy Openship itself, so a project-style
    // Update row here would be a button that 403s.
    listOrganizationUpdates.mockResolvedValue([
      update({ projectId: "proj-self", name: "Openship", appTemplateId: "openship" }),
    ]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0]).toMatchObject({
      scope: "platform",
      resolveWith: [],
      target: { scope: "platform", href: "/settings?tab=instance" },
    });
  });

  it("offers apply for an ordinary project update", async () => {
    listOrganizationUpdates.mockResolvedValue([update()]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].resolveWith).toEqual([
      { label: "Update", method: "POST", path: "/api/updates/proj-2/apply" },
    ]);
  });

  it("ignores an update row that is not actually behind", async () => {
    listOrganizationUpdates.mockResolvedValue([update({ behind: false })]);

    expect((await listOrganizationIssues(ctx)).issues).toEqual([]);
  });
});

describe("targets are the thing an operator acts on", () => {
  it("groups a certificate problem under its HOSTNAME, not the owning project", async () => {
    // An operator with 40 domains scans for the hostname; the fix still lives on
    // the project's Domains tab, so that's where the link goes.
    getOrgPendingActions.mockResolvedValue(
      new Map([
        [
          "proj-1",
          [
            pendingAction({
              id: "domain:dom-1:ssl",
              kind: "ssl_error",
              details: { hostname: "app.example.com" },
            }),
          ],
        ],
      ]),
    );

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0]).toMatchObject({
      scope: "domain",
      source: "domain",
      target: {
        scope: "domain",
        id: "app.example.com",
        name: "app.example.com",
        href: "/projects/proj-1/domains",
      },
    });
  });

  it("groups a held deploy under its project, linked to the tab that answers it", async () => {
    getOrgPendingActions.mockResolvedValue(
      new Map([
        [
          "proj-1",
          [
            pendingAction({
              id: "prompt:dep-1",
              kind: "prompt",
              details: { port: 3000 },
              expiresAt: "2026-08-01T10:15:00.000Z",
            }),
          ],
        ],
      ]),
    );

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0]).toMatchObject({
      scope: "project",
      source: "deploy",
      expiresAt: "2026-08-01T10:15:00.000Z",
      target: { scope: "project", id: "proj-1", name: "storefront", href: "/projects/proj-1/deployments" },
    });
  });

  it("keeps the name the incident recorded when its project is gone", async () => {
    // A rename (or a deletion) must not rewrite what the alert said at the time.
    projectListByOrganization.mockResolvedValue({ rows: [] });
    incidentListByOrg.mockResolvedValue([incident()]);

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues[0].title).toBe("storefront-web");
    expect(issues[0].target.name).toBe("storefront-web");
  });
});

describe("a broken source degrades to a missing section, never a broken page", () => {
  it("still renders every other source when one reader throws", async () => {
    incidentListByOrg.mockRejectedValue(new Error("db gone"));
    loadOrgContainerIssues.mockRejectedValue(new Error("cache miss"));
    listBehindByOrg.mockRejectedValue(new Error("db gone"));
    listOrganizationUpdates.mockRejectedValue(new Error("boom"));
    getOrgPendingActions.mockResolvedValue(new Map([["proj-1", [pendingAction()]]]));

    const { issues } = await listOrganizationIssues(ctx);

    expect(issues.map((i) => i.kind)).toEqual(["domain_unverified"]);
  });
});
