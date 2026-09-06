import { describe, expect, it } from "vitest";
import { serviceLogSource } from "./types";

/**
 * #667 — after a SUCCESSFUL deployment finishes, a compose service tab whose
 * container is running must route its terminal to the live runtime log stream
 * instead of staying frozen on build logs. Everything else keeps the build
 * history: the Prepare tab always, any service while the deploy is still
 * running or ended failed/cancelled, and every service under a held
 * keep/reject decision (some containers there may not exist at all).
 */
describe("serviceLogSource", () => {
  it("routes a running service to the runtime stream once the deploy is ready", () => {
    expect(serviceLogSource({ deploymentStatus: "ready", serviceStatus: "running" })).toBe(
      "runtime",
    );
  });

  it("keeps build logs while the deployment is still in progress", () => {
    for (const deploymentStatus of ["building", "deploying"] as const) {
      expect(serviceLogSource({ deploymentStatus, serviceStatus: "running" })).toBe("build");
    }
  });

  it("never routes to runtime under a held keep/reject decision", () => {
    expect(
      serviceLogSource({
        deploymentStatus: "ready",
        decisionPending: true,
        serviceStatus: "running",
      }),
    ).toBe("build");
  });

  it("keeps build logs for services that are not running after success", () => {
    for (const serviceStatus of ["building", "deploying", "built", "failed", undefined] as const) {
      expect(serviceLogSource({ deploymentStatus: "ready", serviceStatus })).toBe("build");
    }
  });

  it("keeps build logs when the deployment failed or was cancelled", () => {
    for (const deploymentStatus of ["failed", "cancelled"] as const) {
      expect(serviceLogSource({ deploymentStatus, serviceStatus: "running" })).toBe("build");
    }
  });
});
