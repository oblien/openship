import { describe, expect, it } from "vitest";

import {
  composeDeployMadeNoChanges,
  resolveComposeParentContainerId,
  resolveComposePrimaryContainerId,
} from "../../../src/modules/deployments/compose/deploy.service";
import { pickActiveContainerId } from "../../../src/modules/projects/project-runtime.service";

/**
 * A multi-service (compose) deploy where every service is carried forward (kept
 * running, not rebuilt) used to roll up as `ready`, advance the project's active
 * pointer onto an empty release, and record the WRONG parent container (the
 * database an app dependsOn, because the result list follows topoSort — deps
 * first). These three pure helpers close that off:
 *
 *  - composeDeployMadeNoChanges   — detects the all-carried no-op (Fix A part a)
 *  - resolveComposeParentContainerId — records the app, not the db (Fix A part b)
 *  - pickActiveContainerId         — read-path reconciles logs/start/stop onto the
 *                                    app container, self-healing a wrong/sentinel
 *                                    parent id (Fix B)
 */

const svc = (serviceId: string, containerId?: string) => ({
  serviceId,
  serviceName: serviceId,
  status: "running",
  ...(containerId ? { containerId } : {}),
});

describe("composeDeployMadeNoChanges — the all-carried no-op", () => {
  it("is a no-op when nothing was deployed, nothing failed, and nothing was probed", () => {
    expect(
      composeDeployMadeNoChanges({
        summary: { deployed: 0, failed: 0 } as never,
        portChecks: [],
      }),
    ).toBe(true);
  });

  it("is a no-op when portChecks is absent entirely", () => {
    expect(
      composeDeployMadeNoChanges({ summary: { deployed: 0, failed: 0 } as never }),
    ).toBe(true);
  });

  it("is NOT a no-op when at least one service was actually (re)deployed", () => {
    expect(
      composeDeployMadeNoChanges({
        summary: { deployed: 1, failed: 0 } as never,
        portChecks: [],
      }),
    ).toBe(false);
  });

  it("is NOT a no-op when a service failed (a failure must not be buried as 'no changes')", () => {
    expect(
      composeDeployMadeNoChanges({
        summary: { deployed: 0, failed: 1 } as never,
        portChecks: [],
      }),
    ).toBe(false);
  });

  it("is NOT a no-op when a port was probed (defensive — deployed should imply this)", () => {
    expect(
      composeDeployMadeNoChanges({
        summary: { deployed: 0, failed: 0 } as never,
        portChecks: [{ serviceName: "app" } as never],
      }),
    ).toBe(false);
  });

  // Counter integrity: the deploy loop increments `successful` for a carried
  // service but `deployed` ONLY for a real container-create / static (re)serve.
  // So the no-op verdict keys on `deployed`, NOT `successful` — a stack of many
  // carried services (high `successful`) with `deployed === 0` is still a no-op.
  it("keys on deployed, not successful — many carried services stay a no-op", () => {
    expect(
      composeDeployMadeNoChanges({
        summary: { successful: 9, deployed: 0, failed: 0 } as never,
        portChecks: [],
      }),
    ).toBe(true);
  });

  it("is NOT a no-op once one of those services was actually deployed", () => {
    expect(
      composeDeployMadeNoChanges({
        summary: { successful: 9, deployed: 1, failed: 0 } as never,
        portChecks: [],
      }),
    ).toBe(false);
  });
});

describe("resolveComposePrimaryContainerId — no sentinel fallback", () => {
  const services = [
    { serviceId: "db", serviceName: "db", status: "running", containerId: "cid-db" },
    { serviceId: "app", serviceName: "app", status: "running", containerId: "cid-app" },
  ];

  it("returns the captured exposed-app container", () => {
    expect(resolveComposePrimaryContainerId({ primaryContainerId: "cid-app", services })).toBe(
      "cid-app",
    );
  });

  it("falls back to the first container when no app was captured", () => {
    expect(resolveComposePrimaryContainerId({ primaryContainerId: undefined, services })).toBe(
      "cid-db",
    );
  });

  it("returns undefined (NOT the 'compose' sentinel) when nothing came up", () => {
    // The reconciling branch needs undefined here, not "compose" — the parent
    // record's sentinel fallback lives only in resolveComposeParentContainerId.
    expect(
      resolveComposePrimaryContainerId({ primaryContainerId: undefined, services: [] }),
    ).toBeUndefined();
  });
});

describe("resolveComposeParentContainerId — record the app, not the db", () => {
  // topoSort emits dependencies first, so results[0] is the DATABASE for an app
  // that dependsOn its db. The captured primaryContainerId is the exposed app.
  const services = [svc("db", "cid-db"), svc("app", "cid-app")];

  it("records the exposed app container even though the db is first in topo order", () => {
    expect(
      resolveComposeParentContainerId({ primaryContainerId: "cid-app", services }),
    ).toBe("cid-app");
  });

  it("falls back to the first container (legacy behaviour) when no app was resolved", () => {
    expect(
      resolveComposeParentContainerId({ primaryContainerId: undefined, services }),
    ).toBe("cid-db");
  });

  it("falls back to the compose sentinel when nothing has a container", () => {
    expect(
      resolveComposeParentContainerId({ primaryContainerId: undefined, services: [] }),
    ).toBe("compose");
  });
});

describe("pickActiveContainerId — read-path reconciliation", () => {
  const exposed = new Set(["app"]);

  it("trusts the recorded id for a single-app deployment (no service rows)", () => {
    expect(
      pickActiveContainerId({
        recordedContainerId: "cid-single",
        serviceDeployments: [],
        exposedServiceIds: new Set(),
      }),
    ).toBe("cid-single");
  });

  it("prefers the exposed app container when the recorded parent is the db", () => {
    expect(
      pickActiveContainerId({
        recordedContainerId: "cid-db", // mis-recorded dependency
        serviceDeployments: [svc("db", "cid-db"), svc("app", "cid-app")],
        exposedServiceIds: exposed,
      }),
    ).toBe("cid-app");
  });

  it("resolves the app container even when the parent is the 'compose' sentinel", () => {
    expect(
      pickActiveContainerId({
        recordedContainerId: "compose", // all-carried legacy sentinel
        serviceDeployments: [svc("db", "cid-db"), svc("app", "cid-app")],
        exposedServiceIds: exposed,
      }),
    ).toBe("cid-app");
  });

  it("falls back to the recorded id when no exposed row is resolvable", () => {
    expect(
      pickActiveContainerId({
        recordedContainerId: "cid-primary",
        serviceDeployments: [svc("worker", "cid-worker")],
        exposedServiceIds: new Set(), // nothing exposed
      }),
    ).toBe("cid-primary");
  });

  it("never returns the 'compose' sentinel as a usable container id", () => {
    expect(
      pickActiveContainerId({
        recordedContainerId: "compose",
        serviceDeployments: [],
        exposedServiceIds: new Set(),
      }),
    ).toBeNull();
  });
});
