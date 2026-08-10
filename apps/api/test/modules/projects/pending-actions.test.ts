import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pending-actions aggregator: "what is waiting on a human, and what exactly
 * resolves it".
 *
 * Two properties matter most and are easy to regress:
 *
 *   1. A BLOCKED deploy is read off the LATEST deployment, not the active one. A
 *      failed deploy never becomes `activeDeploymentId`, so every pre-existing
 *      attention flag (all derived from the active deployment) was structurally
 *      blind to it. If this reverts to reading only the active row, a blocked
 *      deploy silently disappears again.
 *
 *   2. Every item carries its resolution AS DATA. The port-conflict prompt is
 *      answered with the literal action id "free_port", which used to be
 *      undiscoverable — the responder endpoint was exposed while the payload
 *      naming the ids was not. A caller must never have to guess an id.
 */

const {
  projectFindById,
  projectListByOrganization,
  findLatestByProject,
  findLatestByProjects,
  deploymentFindById,
  findManyById,
  listByProject,
  listByProjects,
} = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  projectListByOrganization: vi.fn(),
  findLatestByProject: vi.fn(),
  findLatestByProjects: vi.fn(),
  deploymentFindById: vi.fn(),
  findManyById: vi.fn(),
  listByProject: vi.fn(),
  listByProjects: vi.fn(),
}));
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: projectFindById, listByOrganization: projectListByOrganization },
    deployment: {
      findLatestByProject,
      findLatestByProjects,
      findById: deploymentFindById,
      findManyById,
    },
    domain: { listByProject, listByProjects },
  },
}));

vi.mock("../../../src/modules/deployments/session-manager", () => ({ getSession }));

import {
  getDeploymentPendingActions,
  getOrgPendingActions,
  getProjectPendingActions,
} from "../../../src/modules/projects/pending-actions.service";

const ORG = "org-1";
const PROJECT = "proj-1";

const dep = (over: Record<string, unknown> = {}) => ({
  id: "dep-1",
  organizationId: ORG,
  status: "ready",
  meta: null,
  errorCode: null,
  errorDetails: null,
  errorMessage: null,
  ...over,
});

const blockedByPort = (over: Record<string, unknown> = {}) =>
  dep({
    id: "dep-blocked",
    status: "action_required",
    errorCode: "PORT_IN_USE",
    errorMessage: "Deploy aborted: port 3000 is in use by node server.js (PID 1512676)",
    errorDetails: {
      port: 3000,
      pid: 1512676,
      command: "node server.js (PID 1512676)",
      isManagedDeployment: false,
    },
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();

  projectFindById.mockResolvedValue({
    id: PROJECT,
    organizationId: ORG,
    activeDeploymentId: null,
  });
  findLatestByProject.mockResolvedValue(null);
  deploymentFindById.mockResolvedValue(null);
  listByProject.mockResolvedValue([]);
  getSession.mockReturnValue(undefined);

  projectListByOrganization.mockResolvedValue({ rows: [] });
  findLatestByProjects.mockResolvedValue(new Map());
  findManyById.mockResolvedValue(new Map());
  listByProjects.mockResolvedValue(new Map());
});

describe("deploy_blocked — the case nothing could see before", () => {
  it("is surfaced from the LATEST deploy even while an older release is live", async () => {
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: ORG,
      activeDeploymentId: "dep-live",
    });
    findLatestByProject.mockResolvedValue(blockedByPort());
    deploymentFindById.mockResolvedValue(dep({ id: "dep-live", status: "ready" }));

    const actions = await getProjectPendingActions(PROJECT, ORG);

    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("deploy_blocked");
    expect(actions[0].severity).toBe("action_required");
    expect(actions[0].title).toBe("Port 3000 is in use");
  });

  it("offers redeploy as the resolution — the artifact is gone, so there is no resume", async () => {
    findLatestByProject.mockResolvedValue(blockedByPort());

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.resolveWith).toEqual([
      { label: "Redeploy", method: "POST", path: "/api/deployments/dep-blocked/redeploy" },
    ]);
    expect(action.details).toMatchObject({ port: 3000, pid: 1512676 });
  });

  it("does not imply a foreign process is safe to kill", async () => {
    findLatestByProject.mockResolvedValue(blockedByPort());

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.message).toContain("does not manage");
    expect(action.message).toContain("node server.js");
  });

  it("says Openship will stop it when the holder is our OWN stale deployment", async () => {
    findLatestByProject.mockResolvedValue(
      blockedByPort({
        errorDetails: {
          port: 3000,
          pid: 42,
          command: "node server.js (PID 42)",
          isManagedDeployment: true,
        },
      }),
    );

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.message).toContain("previous Openship deployment");
    expect(action.message).toContain("Free Port & Continue");
  });

  it("says it could not tell when ownership was never probed", async () => {
    // The nohup supervisor's PORT_IN_USE carries only {port, pid, command} — no
    // `isManagedDeployment`. Treating absent as false would tell the operator a
    // process is not Openship's when we simply didn't look, and that is the
    // difference between "safe to free" and "might kill something else".
    findLatestByProject.mockResolvedValue(
      blockedByPort({
        errorDetails: { port: 3000, pid: 42, command: "node server.js (PID 42)" },
      }),
    );

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.message).toContain("could not tell");
    expect(action.message).not.toContain("does not manage");
  });

  it("never renders a missing port as 'undefined'", async () => {
    findLatestByProject.mockResolvedValue(blockedByPort({ errorDetails: null }));

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.title).toBe("A required port is in use");
    expect(action.message).not.toContain("undefined");
    expect(action.message).not.toContain("Port undefined");
  });

  it("emits nothing for an ordinary failed deploy", async () => {
    findLatestByProject.mockResolvedValue(dep({ status: "failed", errorMessage: "build broke" }));

    expect(await getProjectPendingActions(PROJECT, ORG)).toEqual([]);
  });
});

describe("prompt — a deploy held right now", () => {
  const heldPrompt = {
    promptId: "port_in_use:3000",
    title: "Port In Use",
    message: "Port 3000 is occupied by node server.js (PID 1512676).",
    actions: [
      { id: "free_port", label: "Free Port & Continue", variant: "danger" },
      { id: "abort", label: "Cancel Deploy", variant: "secondary" },
    ],
    details: { port: 3000, pid: 1512676 },
    expiresAt: "2026-07-31T14:52:10.000Z",
  };

  it("turns each offered action into a callable resolution, ids included", async () => {
    findLatestByProject.mockResolvedValue(dep({ id: "dep-live", status: "deploying" }));
    getSession.mockReturnValue({ currentPrompt: heldPrompt });

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.kind).toBe("prompt");
    expect(action.resolveWith).toEqual([
      {
        label: "Free Port & Continue",
        destructive: true,
        method: "POST",
        path: "/api/deployments/dep-live/build/respond",
        body: { action: "free_port" },
      },
      {
        label: "Cancel Deploy",
        destructive: false,
        method: "POST",
        path: "/api/deployments/dep-live/build/respond",
        body: { action: "abort" },
      },
    ]);
  });

  it("publishes the deadline, so a poller knows how long it has", async () => {
    findLatestByProject.mockResolvedValue(dep({ id: "dep-live", status: "deploying" }));
    getSession.mockReturnValue({ currentPrompt: heldPrompt });

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.expiresAt).toBe("2026-07-31T14:52:10.000Z");
  });

  it("never asks for an answer on a deploy that already settled", async () => {
    // A stale held prompt on a finished session would otherwise read "answer this
    // or the deploy aborts" about a deploy that already aborted — and the answer
    // would go nowhere, since respondToPrompt matches nothing and returns false.
    findLatestByProject.mockResolvedValue(blockedByPort());
    getSession.mockReturnValue({ currentPrompt: heldPrompt });

    const actions = await getProjectPendingActions(PROJECT, ORG);

    expect(actions.map((a) => a.kind)).toEqual(["deploy_blocked"]);
  });
});

describe("release-side items", () => {
  it("offers keep and reject for a partial-failure release", async () => {
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: ORG,
      activeDeploymentId: "dep-live",
    });
    deploymentFindById.mockResolvedValue(
      dep({
        id: "dep-live",
        status: "partial_failure",
        meta: {
          composeDeployment: { decision: "pending", failedServiceNames: ["worker"] },
        },
      }),
    );

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.kind).toBe("partial_decision");
    expect(action.message).toContain("worker");
    expect(action.resolveWith.map((r) => r.path)).toEqual([
      "/api/deployments/dep-live/keep",
      "/api/deployments/dep-live/reject",
    ]);
    expect(action.resolveWith[1].destructive).toBe(true);
  });

  it("offers a routing retry when the edge didn't sync", async () => {
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: ORG,
      activeDeploymentId: "dep-live",
    });
    deploymentFindById.mockResolvedValue(dep({ id: "dep-live", meta: { edgeUnsynced: true } }));

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.kind).toBe("routing_unsynced");
    expect(action.resolveWith[0].path).toBe(`/api/projects/${PROJECT}/routing/retry`);
  });

  it("agrees with the project badge on an EMPTY deployWarning", async () => {
    // `routingUnsynced` on the project card is `typeof deployWarning === "string"`,
    // which is true for "". A truthiness check here instead produced a project
    // badged "Action Required" with an empty list of actions — the exact
    // contradiction the shared predicate exists to prevent.
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: ORG,
      activeDeploymentId: "dep-live",
    });
    deploymentFindById.mockResolvedValue(dep({ id: "dep-live", meta: { deployWarning: "" } }));

    const actions = await getProjectPendingActions(PROJECT, ORG);

    expect(actions.map((a) => a.kind)).toEqual(["routing_unsynced"]);
    // Falls back to generic guidance rather than rendering an empty message.
    expect(actions[0].message.length).toBeGreaterThan(0);
  });
});

describe("domain items", () => {
  it("surfaces an unverified domain with the server's own diagnosis", async () => {
    listByProject.mockResolvedValue([
      {
        id: "dom-1",
        hostname: "app.example.com",
        status: "pending",
        verified: false,
        sslStatus: "none",
        verifyAttempts: 3,
        lastVerifyError: "DNS does not resolve to this server",
      },
    ]);

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.kind).toBe("domain_unverified");
    expect(action.message).toBe("DNS does not resolve to this server");
    expect(action.details).toMatchObject({ verifyAttempts: 3 });
    expect(action.resolveWith[0].path).toBe("/api/domains/dom-1/verify");
  });

  it("does NOT also report an SSL problem for a domain that never verified", async () => {
    // One cause, one item — an unverified hostname has no certificate by
    // definition, so reporting both would double-count it.
    listByProject.mockResolvedValue([
      {
        id: "dom-1",
        hostname: "app.example.com",
        status: "pending",
        verified: false,
        sslStatus: "error",
        verifyAttempts: 1,
        lastVerifyError: null,
      },
    ]);

    const actions = await getProjectPendingActions(PROJECT, ORG);

    expect(actions.map((a) => a.kind)).toEqual(["domain_unverified"]);
  });

  it("surfaces an expired certificate on a verified domain", async () => {
    listByProject.mockResolvedValue([
      {
        id: "dom-1",
        hostname: "app.example.com",
        status: "active",
        verified: true,
        sslStatus: "expired",
        verifyAttempts: 0,
        lastVerifyError: null,
      },
    ]);

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.kind).toBe("ssl_error");
    expect(action.resolveWith.map((r) => r.path)).toEqual([
      "/api/domains/dom-1/renew",
      "/api/domains/dom-1/verify-ssl",
    ]);
  });

  it("ignores a healthy domain and one being removed", async () => {
    listByProject.mockResolvedValue([
      { id: "a", hostname: "ok.example.com", status: "active", verified: true, sslStatus: "active" },
      { id: "b", hostname: "gone.example.com", status: "removing", verified: false, sslStatus: "none" },
    ]);

    expect(await getProjectPendingActions(PROJECT, ORG)).toEqual([]);
  });
});

describe("advisories stay advisories", () => {
  /** A live release whose port probe found nothing listening. */
  const withPortCheck = (
    over: Record<string, unknown>,
    framework?: string,
  ) => {
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: ORG,
      activeDeploymentId: "dep-live",
      framework,
    });
    deploymentFindById.mockResolvedValue(dep({ id: "dep-live", meta: over }));
  };

  it("reports a non-listening port as advisory, never as a blocker", async () => {
    withPortCheck({
      portCheck: [{ port: 8080, serviceId: "svc-1", serviceName: "api", checked: true, listening: false }],
    });

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.kind).toBe("port_advisory");
    expect(action.severity).toBe("advisory");
  });

  /**
   * The dismissal target must match `skipTarget` in PortAdvisoryModal exactly:
   * the numeric PORT for a single-app project, the service id only for compose.
   * Both directions of getting this wrong are silent — a target the dashboard's
   * matcher doesn't recognise keeps its modal nagging, and a mismatched read
   * re-surfaces something the operator already dismissed on every poll.
   */
  it("targets the numeric port on a single-app project, even when a serviceId exists", async () => {
    withPortCheck({
      portCheck: [{ port: 8080, serviceId: "svc-1", checked: true, listening: false }],
    });

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.resolveWith[0]).toMatchObject({
      path: "/api/deployments/dep-live/skip-port-check",
      body: { target: 8080 },
    });
  });

  it("targets the service id on a compose project", async () => {
    withPortCheck(
      { portCheck: [{ port: 8080, serviceId: "svc-1", checked: true, listening: false }] },
      "docker-compose",
    );

    const [action] = await getProjectPendingActions(PROJECT, ORG);

    expect(action.resolveWith[0].body).toEqual({ target: "svc-1" });
  });

  it("respects a dismissal stored as a NUMBER (single-app)", async () => {
    // `skipPortCheck` persists the target verbatim, so this really is a number in
    // the jsonb array. Comparing a stringified port here matched nothing.
    withPortCheck({
      portCheck: [{ port: 8080, serviceId: "svc-1", checked: true, listening: false }],
      portCheckSkipped: [8080],
    });

    expect(await getProjectPendingActions(PROJECT, ORG)).toEqual([]);
  });

  it("respects a dismissal stored as a service id (compose)", async () => {
    withPortCheck(
      {
        portCheck: [{ port: 8080, serviceId: "svc-1", checked: true, listening: false }],
        portCheckSkipped: ["svc-1"],
      },
      "docker-compose",
    );

    expect(await getProjectPendingActions(PROJECT, ORG)).toEqual([]);
  });

  it("sorts blockers ahead of advisories", async () => {
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: ORG,
      activeDeploymentId: "dep-live",
    });
    findLatestByProject.mockResolvedValue(blockedByPort());
    deploymentFindById.mockResolvedValue(
      dep({
        id: "dep-live",
        meta: {
          portCheck: [{ port: 8080, serviceId: "svc-1", checked: true, listening: false }],
        },
      }),
    );

    const actions = await getProjectPendingActions(PROJECT, ORG);

    expect(actions.map((a) => a.severity)).toEqual(["action_required", "advisory"]);
  });
});

/**
 * The org-wide loader behind the global issue feed. It exists to be BULK — the
 * whole reason the feed is cheap — and to be identical to the project view, since
 * both funnel through `collectPendingActions`. Both properties are silent when
 * broken: a per-project fallback still renders, it just costs 3 queries × N.
 */
describe("org scope", () => {
  const withOneProject = (over: Record<string, unknown> = {}) => {
    const project = { id: PROJECT, organizationId: ORG, activeDeploymentId: "dep-live", ...over };
    const latest = blockedByPort();
    const active = dep({
      id: "dep-live",
      status: "partial_failure",
      meta: { composeDeployment: { decision: "pending", failedServiceNames: ["worker"] } },
    });
    const domains = [
      {
        id: "dom-1",
        hostname: "app.example.com",
        status: "pending",
        verified: false,
        sslStatus: "none",
        verifyAttempts: 3,
        lastVerifyError: "DNS does not resolve to this server",
      },
    ];

    // Project-scoped reads.
    projectFindById.mockResolvedValue(project);
    findLatestByProject.mockResolvedValue(latest);
    deploymentFindById.mockResolvedValue(active);
    listByProject.mockResolvedValue(domains);
    // The same rows, bulk-shaped.
    projectListByOrganization.mockResolvedValue({ rows: [project] });
    findLatestByProjects.mockResolvedValue(new Map([[PROJECT, latest]]));
    findManyById.mockResolvedValue(new Map([["dep-live", active]]));
    listByProjects.mockResolvedValue(new Map([[PROJECT, domains]]));
  };

  it("emits exactly what the project's own view emits", async () => {
    withOneProject();

    const [one, all] = await Promise.all([
      getProjectPendingActions(PROJECT, ORG),
      getOrgPendingActions(ORG),
    ]);

    expect(all.get(PROJECT)).toEqual(one);
    // Not vacuously equal — this project really has all three item families.
    expect(one.map((a) => a.kind)).toEqual([
      "deploy_blocked",
      "partial_decision",
      "domain_unverified",
    ]);
  });

  it("loads in bulk — the same query count for 1 project and for 20", async () => {
    withOneProject();
    await getOrgPendingActions(ORG);
    const one = {
      projects: projectListByOrganization.mock.calls.length,
      latest: findLatestByProjects.mock.calls.length,
      active: findManyById.mock.calls.length,
      domains: listByProjects.mock.calls.length,
    };

    vi.clearAllMocks();
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `p-${i}`,
      organizationId: ORG,
      activeDeploymentId: `d-${i}`,
    }));
    projectListByOrganization.mockResolvedValue({ rows: many });
    findLatestByProjects.mockResolvedValue(new Map(many.map((p) => [p.id, blockedByPort()])));
    findManyById.mockResolvedValue(new Map());
    listByProjects.mockResolvedValue(new Map());

    const all = await getOrgPendingActions(ORG);

    expect(all.size).toBe(20);
    expect({
      projects: projectListByOrganization.mock.calls.length,
      latest: findLatestByProjects.mock.calls.length,
      active: findManyById.mock.calls.length,
      domains: listByProjects.mock.calls.length,
    }).toEqual(one);
    expect(one).toEqual({ projects: 1, latest: 1, active: 1, domains: 1 });
    // Per-project readers must stay untouched — one call here is 20 queries.
    expect(findLatestByProject).not.toHaveBeenCalled();
    expect(listByProject).not.toHaveBeenCalled();
  });

  it("asks for the active deployments in ONE lookup, only for projects that have one", async () => {
    const rows = [
      { id: "p-1", organizationId: ORG, activeDeploymentId: "d-1" },
      { id: "p-2", organizationId: ORG, activeDeploymentId: null },
      { id: "p-3", organizationId: ORG, activeDeploymentId: "d-3" },
    ];
    projectListByOrganization.mockResolvedValue({ rows });

    await getOrgPendingActions(ORG);

    expect(findLatestByProjects).toHaveBeenCalledWith(["p-1", "p-2", "p-3"]);
    expect(findManyById).toHaveBeenCalledWith(["d-1", "d-3"]);
  });

  it("omits projects with nothing outstanding, so the feed has no empty groups", async () => {
    projectListByOrganization.mockResolvedValue({
      rows: [
        { id: "p-quiet", organizationId: ORG, activeDeploymentId: null },
        { id: "p-loud", organizationId: ORG, activeDeploymentId: null },
      ],
    });
    findLatestByProjects.mockResolvedValue(new Map([["p-loud", blockedByPort()]]));

    const all = await getOrgPendingActions(ORG);

    expect([...all.keys()]).toEqual(["p-loud"]);
  });

  it("touches nothing else when the org has no projects", async () => {
    projectListByOrganization.mockResolvedValue({ rows: [] });

    expect((await getOrgPendingActions(ORG)).size).toBe(0);
    expect(findLatestByProjects).not.toHaveBeenCalled();
    expect(listByProjects).not.toHaveBeenCalled();
  });
});

describe("scoping", () => {
  it("returns nothing for a project in another org", async () => {
    projectFindById.mockResolvedValue({
      id: PROJECT,
      organizationId: "other-org",
      activeDeploymentId: null,
    });

    expect(await getProjectPendingActions(PROJECT, ORG)).toEqual([]);
  });

  it("returns nothing for a deployment in another org", async () => {
    deploymentFindById.mockResolvedValue(blockedByPort({ organizationId: "other-org" }));

    expect(await getDeploymentPendingActions("dep-blocked", ORG)).toEqual([]);
  });

  it("gives the deployment-scoped view the same blocked item", async () => {
    deploymentFindById.mockResolvedValue(blockedByPort());

    const actions = await getDeploymentPendingActions("dep-blocked", ORG);

    expect(actions.map((a) => a.kind)).toEqual(["deploy_blocked"]);
    expect(actions[0].resolveWith[0].path).toBe("/api/deployments/dep-blocked/redeploy");
  });
});
