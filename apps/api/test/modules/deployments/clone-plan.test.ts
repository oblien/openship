import { describe, expect, it } from "vitest";

import { resolveClonePlan, type ClonePlanInput } from "../../../src/modules/deployments/clone-plan";

const base: ClonePlanInput = {
  effectiveTarget: "server",
  serverId: "srv_1",
  runtimeIsBare: false,
  cloneStrategy: "api-host",
  buildStrategy: "server",
  isDesktop: false,
  forwardGitCredentials: false,
};

describe("resolveClonePlan", () => {
  it("local build → clone runs locally with a local credential", () => {
    const plan = resolveClonePlan({ ...base, effectiveTarget: "server", buildStrategy: "local" });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(true);
    expect(plan.cloneBuildStrategy).toBe("local");
  });

  it("docker + server + api-host clone → api-host clone (local credential), not on server", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "api-host" });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(true);
    expect(plan.cloneBuildStrategy).toBe("local");
  });

  it("docker + server + clone-on-server → on-server clone with a shippable (server) credential", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server" });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.dockerClonesOnServer).toBe(true);
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
    expect(plan.relayEligible).toBe(false); // non-desktop
  });

  it("bare + server → always clones on the server with a server credential", () => {
    const plan = resolveClonePlan({ ...base, runtimeIsBare: true, cloneStrategy: "api-host" });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.dockerClonesOnServer).toBe(false); // bare excluded from the docker warn-case
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  it("SECURITY: contradictory buildStrategy=local + cloneStrategy=server never emits a LOCAL credential for an on-server clone", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server", buildStrategy: "local" });
    // The clone physically runs on the remote server...
    expect(plan.runsOnServer).toBe(true);
    // ...so the credential purpose MUST be "server" (shippable) — never "local",
    // which would ship the operator's broad gh/OAuth token off-host.
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  it("desktop + forwardGitCredentials + on-server clone → relay eligible", () => {
    const plan = resolveClonePlan({
      ...base,
      cloneStrategy: "server",
      isDesktop: true,
      forwardGitCredentials: true,
    });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.relayEligible).toBe(true);
  });

  it("cloud target without a local build → off-host clone needs a remote credential", () => {
    const plan = resolveClonePlan({
      ...base,
      effectiveTarget: "cloud",
      serverId: null,
      buildStrategy: "server",
    });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  /**
   * #346 — a LOCAL target has no server to clone on, so the clone always runs on
   * this host and must use a LOCAL credential, whatever buildStrategy says.
   *
   * This is not a hypothetical: no stack declares `defaultBuildStrategy`, so
   * `resolveStrategy` returns "server" for every caller that omits it. The
   * dashboard always sends it explicitly and so never hit this; MCP, the CLI, CI
   * and webhooks don't, and got a clone tagged "server" for a local deploy —
   * which refuses gh-cli (not shippable) and hard-failed with "No GitHub token
   * available … (purpose: remote)" on a box that could clone perfectly well.
   */
  describe("local target — clone always runs on this host", () => {
    const localBase: ClonePlanInput = { ...base, effectiveTarget: "local", serverId: null };

    it("defaulted buildStrategy=server still clones locally with a local credential", () => {
      const plan = resolveClonePlan({ ...localBase, buildStrategy: "server" });
      expect(plan.runsOnServer).toBe(false);
      expect(plan.runsLocally).toBe(true);
      expect(plan.cloneBuildStrategy).toBe("local");
    });

    it("explicit buildStrategy=local is unchanged", () => {
      const plan = resolveClonePlan({ ...localBase, buildStrategy: "local" });
      expect(plan.runsLocally).toBe(true);
      expect(plan.cloneBuildStrategy).toBe("local");
    });

    it("a bare runtime on a local target does not become an on-server clone", () => {
      // runsOnServer requires effectiveTarget==="server" AND a serverId; bare only
      // forces on-server WITHIN that. A local target has neither.
      const plan = resolveClonePlan({ ...localBase, runtimeIsBare: true });
      expect(plan.runsOnServer).toBe(false);
      expect(plan.cloneBuildStrategy).toBe("local");
    });

    it("never relay-eligible: there is no remote build host to forward to", () => {
      const plan = resolveClonePlan({
        ...localBase,
        isDesktop: true,
        forwardGitCredentials: true,
      });
      expect(plan.relayEligible).toBe(false);
    });
  });
});
