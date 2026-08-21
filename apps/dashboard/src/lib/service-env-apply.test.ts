import { describe, expect, it } from "vitest";
import { serviceEnvApplyTrigger } from "./service-env-apply";

// #669 regression: after saving a service's env vars there must be a way to
// push them live WITHOUT a full rebuild — the same fast path the project-level
// EnvVarsEditor has ("Apply (restart, no rebuild)" → deployApi.trigger).
// The backend already honors this exact contract on POST /deployments
// (deployment.controller.ts): refresh=true + explicit serviceIds recreates only
// those services from their existing images.
describe("serviceEnvApplyTrigger", () => {
  it("builds an env-only refresh trigger scoped to the single service", () => {
    expect(serviceEnvApplyTrigger({ projectId: "p1", serviceId: "svc1" })).toEqual({
      projectId: "p1",
      refresh: true,
      serviceIds: ["svc1"],
    });
  });

  it("carries no branch/commit — a refresh must never pull or build source", () => {
    const trigger = serviceEnvApplyTrigger({ projectId: "p1", serviceId: "svc1" });
    expect(trigger).not.toHaveProperty("branch");
    expect(trigger).not.toHaveProperty("commitSha");
  });
});
