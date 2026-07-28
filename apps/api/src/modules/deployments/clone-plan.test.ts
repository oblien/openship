import { describe, it, expect } from "vitest";
import { resolveClonePlan, type ClonePlanInput } from "./clone-plan";

const base: ClonePlanInput = {
  effectiveTarget: "server",
  serverId: "srv_1",
  runtimeIsBare: false,
  cloneStrategy: "server",
  buildStrategy: "server",
  isDesktop: true,
  repoIsGithub: true,
};

describe("resolveClonePlan — relayEligible (forward is the default on desktop)", () => {
  it("is eligible for a desktop server clone when forwarding is unset (default-on)", () => {
    expect(resolveClonePlan({ ...base, forwardGitCredentials: undefined }).relayEligible).toBe(true);
  });

  it("is eligible when forwarding is explicitly true", () => {
    expect(resolveClonePlan({ ...base, forwardGitCredentials: true }).relayEligible).toBe(true);
  });

  it("is NOT eligible when explicitly opted out (false)", () => {
    expect(resolveClonePlan({ ...base, forwardGitCredentials: false }).relayEligible).toBe(false);
  });

  it("is NOT eligible off-desktop (self-hosted / cloud orchestrator)", () => {
    expect(resolveClonePlan({ ...base, isDesktop: false }).relayEligible).toBe(false);
  });

  it("is NOT eligible when the clone doesn't run on the server", () => {
    // api-host clone of a non-github repo → not on-server → no relay.
    expect(
      resolveClonePlan({
        ...base,
        cloneStrategy: "api-host",
        repoIsGithub: false,
      }).relayEligible,
    ).toBe(false);
  });
});
