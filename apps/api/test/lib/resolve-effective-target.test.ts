import { describe, expect, it } from "vitest";
import { resolveEffectiveTarget } from "../../src/lib/deployment-runtime";
import type { DeploymentMeta } from "../../src/lib/deployment-runtime";

// A deployment PINNED to a serverId must route over SSH to that server no matter
// the host platform — including the DESKTOP app operating a remote server. The
// old code short-circuited desktop → "cloud" and ignored serverId, so a
// desktop→remote-server deploy's edge/SSL silently fell back to the laptop's
// noop provider (certbot never ran on the server). serverId is the flexible,
// auto-detected signal — not a hardcoded per-mode assumption.

const meta = (m: Partial<DeploymentMeta>): DeploymentMeta => m as DeploymentMeta;

describe("resolveEffectiveTarget", () => {
  it("routes a server-pinned deployment to SSH regardless of host platform", () => {
    expect(resolveEffectiveTarget("desktop", meta({ serverId: "srv_1" }))).toBe("server");
    expect(resolveEffectiveTarget("selfhosted", meta({ serverId: "srv_1" }))).toBe("server");
    // even without an explicit deployTarget — the serverId alone is enough.
    expect(resolveEffectiveTarget("desktop", meta({ serverId: "srv_1", deployTarget: undefined }))).toBe("server");
  });

  it("desktop with no server falls back to its deployTarget (or cloud)", () => {
    expect(resolveEffectiveTarget("desktop", meta({}))).toBe("cloud");
    expect(resolveEffectiveTarget("desktop", meta({ deployTarget: "cloud" }))).toBe("cloud");
    expect(resolveEffectiveTarget("desktop", meta({ deployTarget: "local" }))).toBe("local");
  });

  it("selfhosted server/local/cloud resolution is unchanged", () => {
    expect(resolveEffectiveTarget("selfhosted", meta({ deployTarget: "server" }))).toBe("server");
    expect(resolveEffectiveTarget("selfhosted", meta({}))).toBe("local");
    expect(
      resolveEffectiveTarget("selfhosted", meta({ deployTarget: "cloud", buildStrategy: "local" })),
    ).toBe("cloud");
  });

  it("the SaaS (cloud base) never routes to SSH even with a stray serverId", () => {
    expect(resolveEffectiveTarget("cloud", meta({ serverId: "srv_1" }))).toBe("cloud");
  });
});
