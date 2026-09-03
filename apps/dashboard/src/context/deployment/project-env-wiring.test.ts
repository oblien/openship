import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useDeploymentBuild.tsx", import.meta.url), "utf8");

describe("project env persistence wiring", () => {
  it("persists the env diff before reporting a config-only save as successful", () => {
    const start = source.indexOf("if (saveConfigOnly)");
    const end = source.indexOf("const isServiceDeployment", start);
    const saveOnlyBranch = source.slice(start, end);

    const mergeIndex = saveOnlyBranch.indexOf("projectsApi.mergeEnv");
    const successIndex = saveOnlyBranch.indexOf('showToast("Configuration saved"');
    expect(mergeIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeGreaterThan(mergeIndex);
  });

  it("only gives build/access env values from the new-project plan", () => {
    const start = source.indexOf("const data = await deployApi.buildAccess");
    const end = source.indexOf("if (!data.success", start);
    const buildAccessCall = source.slice(start, end);

    expect(buildAccessCall).toContain("envVars: envPlan.deployEnvVars");
    expect(buildAccessCall).not.toContain("ENV_MASK");
  });
});
