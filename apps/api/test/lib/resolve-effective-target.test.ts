import { describe, expect, it } from "vitest";
import { resolveEffectiveTarget } from "@repo/platform/engine/lib/deployment-runtime";
import type { DeploymentMeta } from "@repo/platform/engine/lib/deployment-runtime";

// A deployment PINNED to a serverId must route over SSH to that server no matter
// the host platform — including the DESKTOP app operating a remote server. The
// old code short-circuited desktop → "cloud" and ignored serverId, so a
// desktop→remote-server deploy's edge/SSL silently fell back to the laptop's
// noop provider (certbot never ran on the server). serverId is the flexible,
// auto-detected signal — not a hardcoded per-mode assumption.

const meta = (m: Partial<DeploymentMeta>): DeploymentMeta => m as DeploymentMeta;

describe("resolveEffectiveTarget", () => {
  it.each(["desktop", "selfhosted", "cloud"] as const)("keeps a bound Cloud Docker build on Oblien from %s", base => {
    expect(resolveEffectiveTarget(base, meta({ deployTarget: "cloud", buildStrategy: "server",
      runtimeMode: "docker", cloudDockerWorkspace: { projectId: "project-a", workspaceId: "vm-a" } }))).toBe("cloud");
  });
  it.each([{ deployTarget: "local" }, { serverId: "server-a" }] as const)("refuses conflicting Cloud Docker placement %j", conflict => {
    expect(() => resolveEffectiveTarget("selfhosted", meta({ ...conflict,
      cloudDockerWorkspace: { projectId: "project-a", workspaceId: "vm-a" } }))).toThrow("conflicts");
  });
  it("keeps an existing provider workspace on Cloud during self-hosted cleanup", () => {
    expect(resolveEffectiveTarget("selfhosted", meta({ deployTarget: "cloud", workspaceId: "existing-vm" }))).toBe("cloud");
  });
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
