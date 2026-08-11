import { describe, it, expect } from "vitest";
import {
  composeNamespaceDependencies,
  ownsNetworkEndpoint,
  parseComposeNamespace,
} from "./compose-namespace";

describe("parseComposeNamespace", () => {
  it("accepts the sharing forms and echoes the value back verbatim", () => {
    expect(parseComposeNamespace("service:gluetun", "network_mode")).toEqual({
      ok: true,
      ref: { kind: "service", service: "gluetun" },
      value: "service:gluetun",
    });
    expect(parseComposeNamespace("container:abc123", "pid")).toEqual({
      ok: true,
      ref: { kind: "container", container: "abc123" },
      value: "container:abc123",
    });
    expect(parseComposeNamespace("none", "network_mode")).toEqual({
      ok: true,
      ref: { kind: "none" },
      value: "none",
    });
  });

  it("REFUSES host, and says why in a way an operator can act on", () => {
    // The decision this module exists for: a host-netns container binds host
    // interfaces directly (voiding the loopback/edge invariant) and can reach
    // Openship's own loopback API, which grants zero-auth to loopback callers.
    for (const field of ["network_mode", "pid"] as const) {
      const parsed = parseComposeNamespace("host", field);
      expect(parsed?.ok).toBe(false);
      expect(parsed && !parsed.ok && parsed.reason).toContain(field);
      expect(parsed && !parsed.ok && parsed.reason).toMatch(/not supported/);
    }
  });

  it("treats the compose default network as already satisfied, not as an error", () => {
    // The project network IS the default here, so `bridge`/`default` ask for
    // nothing we aren't already doing — reporting them would be noise.
    expect(parseComposeNamespace("bridge", "network_mode")).toBeUndefined();
    expect(parseComposeNamespace("default", "network_mode")).toBeUndefined();
  });

  it("`none` is a network concept only — as a pid mode it is not a valid value", () => {
    expect(parseComposeNamespace("none", "pid")?.ok).toBe(false);
  });

  it("rejects anything else rather than passing it to the daemon", () => {
    // A user-defined network name is a real compose value we can't honor; letting
    // it through would reach Docker as an unresolvable NetworkMode at create.
    expect(parseComposeNamespace("my-custom-net", "network_mode")?.ok).toBe(false);
    expect(parseComposeNamespace("service:", "network_mode")?.ok).toBe(false);
    expect(parseComposeNamespace("container:", "pid")?.ok).toBe(false);
    expect(parseComposeNamespace("service:bad name", "network_mode")?.ok).toBe(false);
    expect(parseComposeNamespace(42, "pid")?.ok).toBe(false);
  });

  it("ignores absent and blank values", () => {
    expect(parseComposeNamespace(undefined, "pid")).toBeUndefined();
    expect(parseComposeNamespace(null, "pid")).toBeUndefined();
    expect(parseComposeNamespace("   ", "network_mode")).toBeUndefined();
  });
});

describe("composeNamespaceDependencies", () => {
  it("reports only the in-stack service references, deduped", () => {
    // These become deploy-order dependencies: the provider must be running before
    // the dependent is created, because Docker resolves container:<id> at create.
    expect(
      composeNamespaceDependencies({ networkMode: "service:vpn", pidMode: "service:vpn" }),
    ).toEqual(["vpn"]);
    expect(
      composeNamespaceDependencies({ networkMode: "service:vpn", pidMode: "service:app" }),
    ).toEqual(["vpn", "app"]);
  });

  it("has nothing to order for container:, none, or an absent mode", () => {
    expect(composeNamespaceDependencies({ networkMode: "container:abc" })).toEqual([]);
    expect(composeNamespaceDependencies({ networkMode: "none" })).toEqual([]);
    expect(composeNamespaceDependencies(null)).toEqual([]);
    expect(composeNamespaceDependencies(undefined)).toEqual([]);
  });
});

describe("ownsNetworkEndpoint", () => {
  it("is false for EVERY declared mode, `none` included", () => {
    // The one predicate behind both the runtime's create-payload suppression and
    // the deploy path's route/host-port decisions. `none` is the case that matters:
    // an earlier draft asked "does it SHARE a namespace" on one side and "does it
    // have an endpoint" on the other, so a `network_mode: none` service was given a
    // pinned loopback port and a live route to a container that publishes nothing.
    expect(ownsNetworkEndpoint("container:abc")).toBe(false);
    expect(ownsNetworkEndpoint("none")).toBe(false);
  });

  it("is true only when nothing was declared", () => {
    expect(ownsNetworkEndpoint(undefined)).toBe(true);
    expect(ownsNetworkEndpoint(null)).toBe(true);
  });
});
