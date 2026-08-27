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
    expect(plan.cloneRunsOnTarget).toBe(false);
    expect(plan.sourceLocation).toBe("api-host");
    expect(plan.cloneCredentialPurpose).toBe("local");
  });

  it("docker + server + api-host clone → api-host clone (local credential), not on server", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "api-host" });
    expect(plan.cloneRunsOnTarget).toBe(false);
    expect(plan.sourceLocation).toBe("api-host");
    expect(plan.cloneCredentialPurpose).toBe("local");
  });

  it("docker + server + clone-on-server → on-server clone with a shippable (server) credential", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server" });
    expect(plan.cloneRunsOnTarget).toBe(true);
    expect(plan.dockerClonesOnTarget).toBe(true);
    expect(plan.sourceLocation).toBe("target");
    expect(plan.cloneCredentialPurpose).toBe("server");
    expect(plan.relayEligible).toBe(false); // non-desktop
  });

  it("bare + server → always clones on the server with a server credential", () => {
    const plan = resolveClonePlan({ ...base, runtimeIsBare: true, cloneStrategy: "api-host" });
    expect(plan.cloneRunsOnTarget).toBe(true);
    expect(plan.dockerClonesOnTarget).toBe(false); // bare excluded from the docker warn-case
    expect(plan.cloneCredentialPurpose).toBe("server");
  });

  it("SECURITY: contradictory buildStrategy=local + cloneStrategy=server never emits a LOCAL credential for an on-server clone", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server", buildStrategy: "local" });
    // The clone physically runs on the remote server...
    expect(plan.cloneRunsOnTarget).toBe(true);
    // ...so the credential purpose MUST be "server" (shippable) — never "local",
    // which would ship the operator's broad gh/OAuth token off-host.
    expect(plan.sourceLocation).toBe("target");
    expect(plan.cloneCredentialPurpose).toBe("server");
  });

  it("desktop + forwardGitCredentials + on-server clone → relay eligible", () => {
    const plan = resolveClonePlan({
      ...base,
      cloneStrategy: "server",
      isDesktop: true,
      forwardGitCredentials: true,
    });
    expect(plan.cloneRunsOnTarget).toBe(true);
    expect(plan.relayEligible).toBe(true);
  });

  it("cloud target without a local build → off-host clone needs a remote credential", () => {
    const plan = resolveClonePlan({
      ...base,
      effectiveTarget: "cloud",
      serverId: null,
      buildStrategy: "server",
    });
    expect(plan.cloneRunsOnTarget).toBe(false);
    expect(plan.sourceLocation).toBe("cloud-workspace");
    expect(plan.cloneCredentialPurpose).toBe("server");
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
      expect(plan.cloneRunsOnTarget).toBe(false);
      expect(plan.sourceLocation).toBe("api-host");
      expect(plan.cloneCredentialPurpose).toBe("local");
    });

    it("explicit buildStrategy=local is unchanged", () => {
      const plan = resolveClonePlan({ ...localBase, buildStrategy: "local" });
      expect(plan.sourceLocation).toBe("api-host");
      expect(plan.cloneCredentialPurpose).toBe("local");
    });

    it("a bare runtime on a local target does not become an on-server clone", () => {
      // cloneRunsOnTarget requires effectiveTarget==="server" AND a serverId; bare only
      // forces on-server WITHIN that. A local target has neither.
      const plan = resolveClonePlan({ ...localBase, runtimeIsBare: true });
      expect(plan.cloneRunsOnTarget).toBe(false);
      expect(plan.cloneCredentialPurpose).toBe("local");
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

  describe("Docker source location follows transport capability (#654)", () => {
    it("local socket: server-row deployment acquires source on the API host", () => {
      const plan = resolveClonePlan({
        ...base,
        repoIsGithub: true,
        cloneStrategy: "server",
        dockerTransport: "socket",
      });
      expect(plan.sourceLocation).toBe("api-host");
      expect(plan.cloneRunsOnTarget).toBe(false);
      expect(plan.dockerClonesOnTarget).toBe(false);
      expect(plan.cloneCredentialPurpose).toBe("local");
    });

    it("TCP daemon: context is prepared on the API host because there is no command channel", () => {
      const plan = resolveClonePlan({
        ...base,
        repoIsGithub: true,
        dockerTransport: "tcp",
      });
      expect(plan.sourceLocation).toBe("api-host");
      expect(plan.cloneRunsOnTarget).toBe(false);
    });

    it("remote SSH daemon: target source acquisition remains available", () => {
      const plan = resolveClonePlan({
        ...base,
        repoIsGithub: true,
        dockerTransport: "ssh",
      });
      expect(plan.sourceLocation).toBe("target");
      expect(plan.cloneRunsOnTarget).toBe(true);
      expect(plan.dockerClonesOnTarget).toBe(true);
    });

    it("local build strategy stays API-host unless explicit target cloning was requested", () => {
      const automatic = resolveClonePlan({
        ...base,
        repoIsGithub: true,
        buildStrategy: "local",
        cloneStrategy: "api-host",
        dockerTransport: "ssh",
      });
      expect(automatic.sourceLocation).toBe("api-host");

      const explicit = resolveClonePlan({
        ...base,
        repoIsGithub: true,
        buildStrategy: "local",
        cloneStrategy: "server",
        dockerTransport: "ssh",
      });
      expect(explicit.sourceLocation).toBe("target");
      expect(explicit.cloneCredentialPurpose).toBe("server");
    });

    it("bare runtime still uses its target executor; Docker transport is irrelevant", () => {
      const plan = resolveClonePlan({
        ...base,
        runtimeIsBare: true,
        dockerTransport: "socket",
      });
      expect(plan.sourceLocation).toBe("target");
      expect(plan.cloneRunsOnTarget).toBe(true);
      expect(plan.dockerClonesOnTarget).toBe(false);
    });
  });
});
