import { describe, it, expect } from "vitest";
import {
  runDeployPipeline,
  type DeployEnvironment,
  type DeployPipelineInput,
  type DeployRouting,
} from "./deploy-pipeline";
import type { BuildLogger } from "./build-pipeline";
import type { DeployConfig } from "../types";

// Minimal logger — the pipeline only calls step()/log()/callback().
function fakeLogger(): BuildLogger {
  return {
    step: () => {},
    log: () => {},
    callback: () => {},
  } as unknown as BuildLogger;
}

// The pipeline reads only config.port (and only when resolveTargetUrl is set,
// which these tests don't use), so a minimal cast is safe.
const config = { deploymentId: "new", projectId: "p", port: 3000 } as unknown as DeployConfig;

function makeInput(over: Partial<DeployPipelineInput> = {}): DeployPipelineInput {
  return { config, previousContainerId: "old", domains: [], ...over };
}

/** Build an env that records the order of lifecycle calls into `events`. */
function recordingEnv(events: string[], over: Partial<DeployEnvironment> = {}): DeployEnvironment {
  return {
    canOverlap: false,
    activate: async () => {
      events.push("activate");
      return { containerId: "new-container" };
    },
    deactivate: async () => {
      events.push("deactivate");
    },
    // resolveRoute is invoked during the route step → lets us assert ordering.
    resolveRoute: async () => {
      events.push("route");
      return { targetUrl: "http://127.0.0.1:3000" };
    },
    ...over,
  };
}

describe("runDeployPipeline cutover ordering", () => {
  it("overlap: activate → health → route → deactivate (old stopped LAST)", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      healthCheck: async () => {
        events.push("health");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "health", "route", "deactivate"]);
  });

  it("overlap: activate failure NEVER stops the old deployment (zero-impact auto-revert)", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      activate: async () => {
        events.push("activate");
        throw new Error("container failed to start");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toContain("activate");
    expect(events).not.toContain("deactivate"); // old left running + routed
    expect(events).not.toContain("route");
  });

  it("overlap: health-gate failure stops nothing — old keeps serving", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      healthCheck: async () => {
        events.push("health");
        throw new Error("not healthy");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toEqual(["activate", "health"]); // never routed, never deactivated
  });

  it("non-overlap (bare): deactivate old FIRST, then activate → route", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: false });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("ready");
    expect(events).toEqual(["deactivate", "activate", "route"]);
  });

  it("non-overlap: activate failure restarts the old deployment exactly once (auto-revert)", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      activate: async () => {
        events.push("activate");
        throw new Error("port bind failed");
      },
      reactivatePrevious: async () => {
        events.push("reactivate");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toEqual(["deactivate", "activate", "reactivate"]);
    expect(events.filter((e) => e === "reactivate")).toHaveLength(1);
  });

  it("first deploy (no previous): overlap never calls deactivate", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: true });

    const res = await runDeployPipeline(env, makeInput({ previousContainerId: undefined }), fakeLogger());

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "route"]);
  });

  // The non-overlap path has to free a fixed port before the new workload can
  // bind, so the old one MUST stop first. Whether it is stopped-and-kept or
  // destroyed decides what a later failure costs: Docker takes this path whenever
  // routeStrategy is loopback-port (the default), and while its pre-stop
  // force-removed the container, a failed health gate left the project with NO
  // running deployment — the old one deleted and the new one reaped by the caller.
  it("non-overlap: prefers deactivateRetaining over the destructive deactivate", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      retireRetainedPrevious: async () => {
        events.push("retire");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("ready");
    // Retired only AFTER the new one is up and routed, never before.
    expect(events).toEqual(["stop-retaining", "activate", "route", "retire"]);
    expect(events).not.toContain("deactivate");
  });

  it("non-overlap: a failed health gate restores the retained old one and never retires it", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      retireRetainedPrevious: async () => {
        events.push("retire");
      },
      healthCheck: async () => {
        events.push("health");
        throw new Error("never answered on its port");
      },
      reactivatePrevious: async () => {
        events.push("reactivate");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toEqual(["stop-retaining", "activate", "health", "reactivate"]);
    // The whole point: the old deployment is still there to come back to.
    expect(events).not.toContain("retire");
    expect(events).not.toContain("route");
  });

  // Non-overlap exists because old and new contend for ONE fixed port. A
  // health-gate failure means the new workload started fine and is still holding
  // that port, so the revert has to free it first or `start` fails with "port is
  // already allocated" — the caller only reaps the failed container after this
  // returns, which is too late.
  it("non-overlap: stops the FAILED new deployment before restarting the old one", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      healthCheck: async () => {
        events.push("health");
        throw new Error("never answered on its port");
      },
      stopActivated: async (id) => {
        events.push(`stop-activated:${id}`);
      },
      reactivatePrevious: async () => {
        events.push("reactivate");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toEqual([
      "stop-retaining",
      "activate",
      "health",
      "stop-activated:new-container",
      "reactivate",
    ]);
    // Ordering is the assertion: freeing the port must precede the rebind.
    expect(events.indexOf("stop-activated:new-container")).toBeLessThan(events.indexOf("reactivate"));
  });

  it("non-overlap: a failing stopActivated still attempts the revert", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      healthCheck: async () => {
        throw new Error("never answered");
      },
      stopActivated: async () => {
        events.push("stop-activated");
        throw new Error("daemon hiccup");
      },
      reactivatePrevious: async () => {
        events.push("reactivate");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    // Best-effort: a failed stop must not swallow the revert attempt.
    expect(events).toContain("reactivate");
  });

  it("overlap never stops the activated deployment — nothing to free", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      healthCheck: async () => {
        throw new Error("never answered");
      },
      stopActivated: async () => {
        events.push("stop-activated");
      },
      reactivatePrevious: async () => {
        events.push("reactivate");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    // The old one was never stopped, so it is still serving; touching the new
    // container here would be pointless work on a container the caller reaps.
    expect(events).not.toContain("stop-activated");
    expect(events).not.toContain("reactivate");
  });

  it("non-overlap: falls back to deactivate when the env can't retain, and retires nothing", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      retireRetainedPrevious: async () => {
        events.push("retire");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("ready");
    // Nothing was retained, so retire must not fire on a container already gone.
    expect(events).toEqual(["deactivate", "activate", "route"]);
  });

  it("non-overlap: deactivatePrevious=false neither stops nor retires the old one", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      retireRetainedPrevious: async () => {
        events.push("retire");
      },
    });

    const res = await runDeployPipeline(
      env,
      makeInput({ deactivatePrevious: false }),
      fakeLogger(),
    );

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "route"]);
  });

  it("first deploy (no previous): non-overlap retains and retires nothing", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      retireRetainedPrevious: async () => {
        events.push("retire");
      },
    });

    const res = await runDeployPipeline(
      env,
      makeInput({ previousContainerId: undefined }),
      fakeLogger(),
    );

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "route"]);
  });

  it("non-overlap: a failing retire never flips a good deploy to failed", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      deactivateRetaining: async () => {
        events.push("stop-retaining");
      },
      retireRetainedPrevious: async () => {
        events.push("retire");
        throw new Error("daemon hiccup");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    // Cleaning up the OLD deployment is housekeeping; the new one is already live.
    expect(res.status).toBe("ready");
    expect(res.containerId).toBe("new-container");
    expect(events).toEqual(["stop-retaining", "activate", "route", "retire"]);
  });

  it("R1 gate: deactivatePrevious=false leaves the old one running even in overlap mode", async () => {
    // Models build-pipeline's snapshot gate: previousContainerId stays accurate,
    // but deactivatePrevious=false so archivePreviousDeployment can stop+retain
    // the old artifact for rollback. The pipeline must NOT stop it.
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: true });

    const res = await runDeployPipeline(
      env,
      makeInput({ previousContainerId: "old", deactivatePrevious: false }),
      fakeLogger(),
    );

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "route"]); // old never stopped
  });
});

// Domains are OPTIONAL — routing runs after the container is up + healthy, so a
// routing failure must never flip the deploy to "failed". It's collected as a
// per-domain warning on a still-"ready" result.
describe("runDeployPipeline routing is best-effort", () => {
  const domain = { hostname: "app.example.com", tls: false, targetPort: 3000 };

  it("a failing registerRoute never fails the deploy — ready + routeWarnings, container kept", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      healthCheck: async () => {
        events.push("health");
      },
    });
    const routing = {
      registerRoute: async () => {
        events.push("registerRoute");
        throw new Error("nginx reload failed");
      },
      removeRoute: async () => {},
    } as unknown as DeployRouting;

    const res = await runDeployPipeline(env, makeInput({ domains: [domain], routing }), fakeLogger());

    expect(res.status).toBe("ready");
    expect(res.containerId).toBe("new-container"); // NOT destroyed
    expect(res.routeWarnings).toEqual(["app.example.com: nginx reload failed"]);
    expect(events).toContain("registerRoute");
  });

  it("an invalid route target is skipped with a warning, never reaching registerRoute", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: true });
    const routing = {
      registerRoute: async () => {
        events.push("registerRoute");
      },
      removeRoute: async () => {},
    } as unknown as DeployRouting;
    // Neither targetPort nor targetPath → INVALID_ROUTE_TARGET inside registration.
    const badDomain = { hostname: "bad.example.com", tls: false };

    const res = await runDeployPipeline(env, makeInput({ domains: [badDomain], routing }), fakeLogger());

    expect(res.status).toBe("ready");
    expect(res.routeWarnings?.[0]).toContain("bad.example.com");
    expect(events).not.toContain("registerRoute");
  });

  it("all routes register cleanly → no routeWarnings on the result", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: true });
    const routing = {
      registerRoute: async () => {
        events.push("registerRoute");
      },
      removeRoute: async () => {},
    } as unknown as DeployRouting;

    const res = await runDeployPipeline(env, makeInput({ domains: [domain], routing }), fakeLogger());

    expect(res.status).toBe("ready");
    expect(res.routeWarnings).toBeUndefined();
    expect(events).toContain("registerRoute");
  });
});
