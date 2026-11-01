import { describe, expect, it } from "vitest";
import { BuildLogger, runDeployPipeline, type DeployConfig } from "@repo/adapters";
import { roleHandoverEnvironment } from "@repo/platform/engine/modules/deployments/role-handover-environment";

const config = { deploymentId: "candidate", projectId: "project", port: 3000 } as DeployConfig;

describe("role handover and web publication", () => {
  it.each([true, false])(
    "records commit after readiness/routing and before removal (overlap=%s)",
    async (canOverlap) => {
      const events: string[] = [];
      const env = roleHandoverEnvironment(
        {
          canOverlap,
          activate: async () => {
            events.push("create");
            return { containerId: "candidate-web" };
          },
          healthCheck: async () => {
            events.push("healthy");
          },
          resolveRoute: async () => {
            events.push("route");
            return { targetUrl: "http://127.0.0.1:3000" };
          },
          deactivate: async () => {
            events.push("remove");
          },
          deactivateRetaining: async () => {
            events.push("stop");
          },
          retireRetainedPrevious: async () => {
            events.push("remove");
          },
        },
        {
          recordWeb: async () => {
            events.push("record-created");
          },
          stopPreviousWeb: async () => {
            events.push("record-stop");
          },
          committing: async () => {
            events.push("commit");
          },
        },
      );
      const result = await runDeployPipeline(
        env,
        { config, domains: [], previousContainerId: "previous-web" },
        new BuildLogger(() => {}),
      );
      expect(result.status).toBe("ready");
      expect(events).toEqual([
        ...(!canOverlap ? ["record-stop", "stop"] : []),
        "create",
        "record-created",
        "healthy",
        "route",
        "commit",
        "remove",
      ]);
    },
  );

  it("leaves the predecessor intact when commit intent could not be written", async () => {
    let oldExists = true;
    const env = roleHandoverEnvironment(
      {
        canOverlap: true,
        activate: async () => ({ containerId: "candidate-web" }),
        deactivate: async () => {
          oldExists = false;
        },
      },
      {
        recordWeb: async () => {},
        stopPreviousWeb: async () => {},
        committing: async () => {
          throw new Error("storage unavailable");
        },
      },
    );
    await runDeployPipeline(
      env,
      { config, domains: [], previousContainerId: "previous-web" },
      new BuildLogger(() => {}),
    );
    // The web pipeline treats retirement errors as warnings. Its caller can
    // still unwind because the predecessor was not irreversibly removed.
    expect(oldExists).toBe(true);
  });
});
