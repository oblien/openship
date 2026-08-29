import { describe, it, expect } from "vitest";
import { rollupDeploymentStatus } from "./service-checks";

/**
 * The contract the GH-585 fix rests on: a service a scoped deploy deliberately left alone is
 * recorded `skipped`, and a `skipped` row must NOT drag the deployment to `partial_failure`.
 *
 * That rollup is what turned one untargeted sibling into a project-wide "Action Required"
 * (build-pipeline.ts rewrites a `ready` deployment to `partial_failure` with
 * `decision: "pending"` the moment this returns it), so the skip only holds as long as
 * `skipped` stays outside the failure bucket. Pinned here rather than left implicit.
 */
describe("rollupDeploymentStatus", () => {
  it("ignores skipped rows — a deploy scoped past a sibling is still ready", () => {
    expect(rollupDeploymentStatus([{ status: "success" }, { status: "skipped" }])).toBe("ready");
  });

  it("is ready when every service was skipped (nothing was asked of them)", () => {
    expect(rollupDeploymentStatus([{ status: "skipped" }, { status: "skipped" }])).toBe("ready");
  });

  // The regression this fix removes: the untargeted sibling used to land here as `failure`.
  it("still reports partial_failure when a real failure is mixed in", () => {
    expect(
      rollupDeploymentStatus([{ status: "success" }, { status: "failure" }, { status: "skipped" }]),
    ).toBe("partial_failure");
  });

  it("reports failed when every non-skipped service failed", () => {
    expect(rollupDeploymentStatus([{ status: "failure" }, { status: "skipped" }])).toBe("failed");
  });

  it("counts a cancelled service as a failure, and running as a success", () => {
    expect(rollupDeploymentStatus([{ status: "running" }, { status: "cancelled" }])).toBe(
      "partial_failure",
    );
  });

  it("is ready for an empty fan-out", () => {
    expect(rollupDeploymentStatus([])).toBe("ready");
  });
});
