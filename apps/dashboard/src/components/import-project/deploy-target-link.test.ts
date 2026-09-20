import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The target row names the machine AND opens it.
 *
 * Both progress screens — single-app (`DeploymentProcessing`) and compose (`ComposeSidebar`) —
 * render the same fact in the same slot, and they already shared the label resolver. One of them
 * growing a link on its own is how "Server · box-1" and "box-1" drifted apart the first time, so
 * the linked value is a shared component rather than two call sites.
 */
const value = readFileSync(new URL("./DeployTargetValue.tsx", import.meta.url), "utf8");
const single = readFileSync(new URL("./DeploymentProcessing.tsx", import.meta.url), "utf8");
const compose = readFileSync(new URL("./compose/ComposeSidebar.tsx", import.meta.url), "utf8");

describe("the shared target value", () => {
  it("links a server target to that server's page", () => {
    expect(value).toContain("href={`/servers/${config.serverId}`}");
  });

  it("links ONLY a server target", () => {
    // Cloud has no per-instance page, and `local` is the box the dashboard already runs on — a
    // link to "here" is a dead end dressed as an action.
    expect(value).toContain('config.deployTarget !== "server" || !config.serverId');
  });

  it("still renders plain text when there is no id to link to", () => {
    expect(value).toContain("<span className={className}>{label}</span>");
  });

  it("reuses the one label resolver rather than re-deriving the words", () => {
    expect(value).toContain("describeBuildTarget(config,");
  });
});

describe("both progress screens use it", () => {
  it("the single-app details row", () => {
    expect(single).toContain("<DeployTargetValue config={config} />");
  });

  it("the compose sidebar row", () => {
    expect(compose).toContain('<DeployTargetValue config={config} className="truncate" />');
  });

  it("neither calls describeBuildTarget for the target row any more", () => {
    // Left behind, the plain-text version would silently win in whichever screen kept it.
    expect(single).not.toContain("value={describeBuildTarget(config, t)}");
    expect(compose).not.toContain("{describeBuildTarget(config, t)}");
  });
});
