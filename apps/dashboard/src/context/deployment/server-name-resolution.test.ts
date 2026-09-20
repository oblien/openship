import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { baseDictionary as en } from "@/i18n";
import { describeBuildTarget } from "@/components/import-project/deploy-target-label";

/**
 * "Target: Server" is the failure this guards.
 *
 * `serverId` is the truth and the name is derived from it, but the derivation lived in three
 * places that each cover only their own entry path — the target step (after a pick), a saved
 * project's `serverName`, and the build-status payload (a loaded deploy). Reach the progress
 * screen any other way — redeploy, a migration's deploy, or a pick whose server list hadn't
 * resolved before the deploy started — and the panel showed the bare word "Server" on the screen
 * that is about to change a machine.
 */
describe("describeBuildTarget", () => {
  it("names the server when the config has one", () => {
    expect(describeBuildTarget({ deployTarget: "server", serverName: "production" }, en as never))
      .toContain("production");
  });

  it("falls back to the generic word only when there is no name", () => {
    const generic = describeBuildTarget({ deployTarget: "server" }, en as never);
    expect(generic).toBe(en.importProject.deploymentProcessing.targetServer);
  });

  it("still describes cloud and local", () => {
    expect(describeBuildTarget({ deployTarget: "cloud" }, en as never))
      .toBe(en.importProject.deploymentProcessing.targetOpenshipCloud);
    expect(describeBuildTarget({ deployTarget: "local" }, en as never))
      .toBe(en.importProject.deploymentProcessing.targetLocal);
  });
});

describe("the config resolves a missing name from the id", () => {
  const src = readFileSync(new URL("./useDeploymentConfig.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("looks the server up when there's an id but no name", () => {
    expect(code).toContain("config.deployTarget !== \"server\" || !config.serverId || config.serverName");
    expect(code).toContain("systemApi\n      .listServers()");
  });

  it("only FILLS the gap — never overwrites a name another path resolved", () => {
    // Three other sources write this field; a blind overwrite would fight them.
    expect(code).toContain("prev.serverName ? prev :");
  });

  it("accepts sshHost when the server has no display name", () => {
    expect(code).toContain("match?.name || match?.sshHost");
  });

  it("writes nothing when the server can't be found", () => {
    // An empty string would render as resolved-but-blank; the generic fallback is honest.
    expect(code).toContain("if (name) setConfig");
  });
});
