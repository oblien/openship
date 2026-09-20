import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buildSource = readFileSync(new URL("./useDeploymentBuild.tsx", import.meta.url), "utf8");
const configSource = readFileSync(new URL("./useDeploymentConfig.ts", import.meta.url), "utf8");

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThan(-1);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("project env persistence wiring", () => {
  it("persists the env diff before reporting a config-only save as successful", () => {
    const saveOnly = section(buildSource, "if (saveConfigOnly)", "const isServiceDeployment");
    const mergeIndex = saveOnly.indexOf("persistProjectEnvDiff");
    const successIndex = saveOnly.indexOf('showToast("Configuration saved"');

    expect(mergeIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeGreaterThan(mergeIndex);
  });

  it("persists an existing-project merge before build/access and omits its full payload", () => {
    const deploy = section(
      buildSource,
      "let resolvedEnvPlan = envPlan",
      "if (data.success && data.deployment_id)",
    );
    const mergeIndex = deploy.indexOf("persistProjectEnvDiff");
    const buildIndex = deploy.indexOf("deployApi.buildAccess");

    expect(mergeIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(mergeIndex);
    expect(deploy).toContain("envVars: resolvedEnvPlan.buildAccessEnvVars");
    expect(deploy).toContain("sourceEnvKeys: resolvedEnvPlan.sourceEnvKeys");
  });

  it("re-reads env when ensure unexpectedly matches an existing project", () => {
    const matched = section(
      buildSource,
      "if (!config.projectId && projectData.created !== true)",
      "// Existing-project env is authoritative",
    );

    expect(matched).toContain("projectsApi.getEnv(projectData.project_id)");
    expect(matched).toContain("planMatchedExistingProjectEnvPersistence");
  });
});

describe("existing-project env hydration wiring", () => {
  it.each([
    ["repository retry", "const initializeFromRepo", "const initializeFromLocal"],
    ["local retry", "const initializeFromLocal", "const rescanWithComposePath"],
    ["folder-upload retry", "const initializeFromUpload", "const initializeFromProject"],
    ["saved-project edit", "const initializeFromProject", "return {"],
  ])("loads env with project metadata for %s", (_name, start, end) => {
    expect(section(configSource, start, end)).toContain("loadPersistedProjectState");
  });

  it("keeps unsaved env edits during a compose-path rescan", () => {
    const rescan = section(
      configSource,
      "const rescanWithComposePath",
      "const initializeFromUpload",
    );
    expect(rescan.match(/preserveEnvState: true/g)).toHaveLength(2);
  });
});
