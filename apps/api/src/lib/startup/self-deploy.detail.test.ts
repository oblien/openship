import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The wizard's structured failure has to carry the CAUSE, not just the code.
 *
 * `provisionSelfAppEdge` forwarded only `reason` — a code callers branch on — so
 * `SelfEdgeInfraResult.detail` (the resolver naming the distro it refuses, a takeover
 * saying the stop was refused unelevated) reached the operator through the live log
 * and nowhere else. A reattaching client, a headless run, or anything reading the
 * finished session got "migrate_failed" with no cause: exactly the cause-less failure
 * #490/#509 were about.
 */

const h = vi.hoisted(() => ({
  infra: { ok: false, reason: "unsupported_host", detail: "" } as {
    ok: boolean;
    reason?: string;
    detail?: string;
  },
  foreignProxy: { blocked: false, owner: "" } as { blocked: boolean; owner?: string },
  reapply: vi.fn(async () => {}),
  project: { id: "p1" } as unknown,
}));

vi.mock("./self-edge", () => ({ ensureSelfEdgeInfra: async () => h.infra }));
vi.mock("./self-services", () => ({ linkSelfAppServices: vi.fn(async () => {}) }));
vi.mock("./index", () => ({ registerStartupHook: vi.fn() }));
vi.mock("../../modules/deployments/build.service", () => ({ createQueuedDeployment: vi.fn() }));
vi.mock("../../modules/deployments/deployment-lifecycle", () => ({ onSuccess: vi.fn() }));
vi.mock("../../modules/domains/project-route.service", () => ({
  reapplyProjectLiveRoutes: h.reapply,
}));
vi.mock("../domain-ssl", () => ({
  manageDomainSsl: vi.fn(async () => ({ verified: false, reason: "challenge failed" })),
  tlsIssuedElsewhere: () => null,
  describeTlsIssuedElsewhere: () => "",
}));
vi.mock("../public-url", () => ({ refreshSelfAppPublicUrl: vi.fn(async () => {}) }));
vi.mock("@repo/adapters", () => ({
  BareRuntime: class {},
  foreignProxyOnEdge: async () => h.foreignProxy,
}));
vi.mock("../ssh-manager", () => ({
  sshManager: { withHostExecutor: async (fn: (e: unknown) => unknown) => fn({}) },
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => h.project },
    domain: { findByHostname: async () => null },
  },
  db: {},
  schema: {},
  eq: vi.fn(),
}));

import { provisionSelfAppEdge, type SelfEdgeStepProgress } from "./self-deploy";
import {
  createSetupSession,
  updateComponentProgress,
  subscribeSetupSession,
} from "../../modules/system/setup-session";

/** Records every step event so the returned payload and the wizard's stream can be
 *  compared — the bug was one of them carrying the diagnosis and the other not. */
function recorder() {
  const steps: { step: string; status: string; detail?: string }[] = [];
  const progress: SelfEdgeStepProgress = {
    onLog: () => {},
    onStep: (step, status, detail) => steps.push({ step, status, detail }),
    backoffs: [],
  };
  return { steps, progress, failed: () => steps.find((s) => s.status === "failed") };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.infra = { ok: false, reason: "unsupported_host", detail: "" };
  h.foreignProxy = { blocked: false };
  h.reapply.mockResolvedValue(undefined);
});

const SUSE = "Openship has no package manager for openSUSE (distro family suse).";

describe("provisionSelfAppEdge failure detail", () => {
  it("returns the infra layer's diagnosis alongside the code, and only when there is one", async () => {
    h.infra = { ok: false, reason: "unsupported_host", detail: SUSE };
    expect(await provisionSelfAppEdge("p1", "app.example.com", 3001, {})).toEqual({
      verified: false,
      reason: "unsupported_host",
      detail: SUSE,
    });
    // The other half of the rule: a layer that diagnosed nothing must not have a
    // `detail` invented for it — an empty key reads as "the cause is blank".
    h.infra = { ok: false, reason: "not_linux" };
    const bare = await provisionSelfAppEdge("p1", "app.example.com", 3001, {});
    expect(bare).toEqual({ verified: false, reason: "not_linux" });
    expect("detail" in bare).toBe(false);
  });

  it("puts the same diagnosis on the failed step the wizard renders", async () => {
    h.infra = { ok: false, reason: "migrate_failed", detail: "port 80 still bound after stop" };
    const r = recorder();
    const res = await provisionSelfAppEdge("p1", "app.example.com", 3001, r.progress);
    expect(r.failed()).toEqual({
      step: "edge",
      status: "failed",
      detail: "port 80 still bound after stop",
    });
    expect(res.detail).toBe(r.failed()?.detail);
  });

  it("reports WHICH proxy still owns 80/443, in the words the log used", async () => {
    h.infra = { ok: true };
    h.foreignProxy = { blocked: true, owner: "nginx" };
    const r = recorder();
    const res = await provisionSelfAppEdge("p1", "app.example.com", 3001, r.progress);
    expect(res.reason).toBe("edge_not_owned");
    expect(res.detail).toContain("nginx");
    expect(r.failed()).toMatchObject({ step: "route", detail: res.detail });
  });

  it("carries the routing pipeline's own error message", async () => {
    h.infra = { ok: true };
    h.reapply.mockRejectedValue(new Error("nginx -t: invalid vhost for app.example.com"));
    const r = recorder();
    const res = await provisionSelfAppEdge("p1", "app.example.com", 3001, r.progress);
    expect(res.reason).toBe("route_failed");
    expect(res.detail).toContain("invalid vhost");
    expect(r.failed()).toMatchObject({ step: "route", detail: res.detail });
  });

  it("carries the last real cert failure, not just cert_pending", async () => {
    h.infra = { ok: true };
    const r = recorder();
    const res = await provisionSelfAppEdge("p1", "app.example.com", 3001, r.progress);
    expect(res.reason).toBe("cert_pending");
    expect(res.detail).toBe("challenge failed");
    expect(r.failed()).toMatchObject({ step: "ssl", detail: "challenge failed" });
  });
});

/**
 * The other end of the plumb: a step's detail has to leave the process. Wired the
 * way self-app.controller.ts wires it, because "the cause is in the live log" was
 * exactly the gap — a client that reattaches after the failure replays progress,
 * not the log lines it missed.
 */
describe("a failed step's detail reaches the wizard's progress stream", () => {
  it("rides the SSE progress frame and the replayed component state", async () => {
    h.infra = { ok: false, reason: "migrate_failed", detail: "vhost write refused: EACCES" };
    const session = createSetupSession([{ name: "edge", label: "Install the edge" }], "self");
    await provisionSelfAppEdge("p1", "app.example.com", 3001, {
      onStep: (step, status, detail) => updateComponentProgress(session.id, step, status, detail),
    });

    const frames: { event: string; data: string }[] = [];
    subscribeSetupSession(session.id, (event, data) => {
      frames.push({ event, data });
      return true;
    });
    const replay = frames.find((f) => f.event === "progress");
    expect(replay?.data).toContain("vhost write refused: EACCES");
  });
});
