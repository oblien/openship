import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import * as deploymentRuntime from "@repo/platform/engine/lib/deployment-runtime";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { previewRestore } from "@repo/platform/engine/modules/deployments/deployment.service";
import { seedDeployment, seedOrg, seedProject, seedService } from "../../helpers/seed";

beforeEach(() => {
  // Exercise the real planner's source-rebuild fallback without a Docker host.
  vi.spyOn(deploymentRuntime, "resolveDeploymentRuntime").mockRejectedValue(
    new Error("test host offline"),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("rollback preview uses the effective Compose environment", () => {
  it.each([
    { name: "an unchanged passthrough", inline: "${TOKEN}", templateKeys: ["TOKEN"], changes: [] },
    { name: "a legacy empty passthrough", inline: "", templateKeys: undefined, changes: [] },
    {
      name: "an authored empty literal",
      inline: "",
      templateKeys: [],
      changes: [
        { key: "TOKEN", direction: "frozen-wins", scopeAmbiguous: true, serviceName: "web" },
      ],
    },
  ])("describes $name using the deployment rules", async ({ inline, templateKeys, changes }) => {
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, { framework: "docker-compose" });
    await seedService(project.id, {
      name: "web",
      environment: { TOKEN: inline },
      advanced: templateKeys ? { environmentTemplateKeys: templateKeys } : null,
    });
    await repos.project.setEnvVar({
      projectId: project.id,
      serviceId: null,
      key: "TOKEN",
      value: encrypt("configured-private-value"),
      environment: "production",
      isSecret: true,
    });
    const target = await seedDeployment(project, {
      commitSha: "a".repeat(40),
      envVars: { TOKEN: encrypt("configured-private-value") },
      meta: { serviceDeploymentMode: "services", composeServices: [{ name: "web" }] },
    });

    const preview = await previewRestore(target.id, organizationId);

    expect(preview.mode).toBe("rebuild");
    expect(preview.env).toEqual({
      strategy: "overlay",
      changes,
      totalChanges: changes.length,
      truncated: false,
    });
    expect(JSON.stringify(preview)).not.toContain("configured-private-value");
  });
});
