import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the compose backend + the host edge preflight so runCompose's ORCHESTRATION
// (gate → preflight → up → import) is exercised without real docker / ss / fs.
const h = vi.hoisted(() => ({
  hasDocker: true,
  composeUpResult: { ok: true, apiPort: "4000", dashPort: "3001" },
  composeUpCalls: 0,
  /** Images fetched BEFORE the edge preflight can stop anyone's proxy. */
  prefetchOk: true,
  prefetchCalls: 0,
  internalToken: "tok" as string | null,
}));
vi.mock("../../src/lib/compose", () => ({
  hasDockerCompose: () => h.hasDocker,
  composeIsViableDefault: () => true,
  // `up` now installs Docker rather than degrading to bare (same helper the
  // wizard uses); the fixture reports whether it's present/installable.
  ensureDocker: async () => h.hasDocker,
  composePrefetch: () => {
    h.prefetchCalls++;
    return h.prefetchOk;
  },
  composeUp: async () => {
    h.composeUpCalls++;
    return h.composeUpResult;
  },
  composeInternalToken: () => h.internalToken,
  // Default install: pulls published images. The dev/from-source build path has
  // its own unit test (compose-source-build.test.ts).
  sourceBuildDir: () => null,
}));

const e = vi.hoisted(() => ({
  plan: { proceed: true } as any,
  calls: 0,
  rollbacks: 0,
  completes: 0,
  restored: true,
  /** Our edge container is crash-looping / exited (the abnormal case). */
  edgeBroken: false,
  edgeCrashReason: null as string | null,
  /** Set once a stopped proxy's sites are imported (suppresses re-offering). */
  marked: 0,
}));
// The edge probes run docker through an executor, which no test box has. Fixture
// controls them like the rest of the edge chain.
vi.mock("@repo/adapters/proxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters/proxy")>()),
  edgeIsBroken: async () => e.edgeBroken,
  edgeCrashReason: async () => e.edgeCrashReason,
}));
vi.mock("@repo/adapters", () => ({ LocalExecutor: class {} }));

vi.mock("../../src/lib/edge-preflight", () => ({
  planAndApplyHostEdge: async () => {
    e.calls++;
    return e.plan;
  },
  rollbackHostEdge: async () => {
    e.rollbacks++;
    return e.restored;
  },
  completeHostEdge: async () => {
    e.completes++;
  },
  markStoppedProxyImported: () => {
    e.marked++;
  },
}));

import { upCommand } from "../../src/commands/up";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

// up.ts prints via console.log/console.error, which vitest intercepts (so the
// harness's process.stdout.write capture misses them). Capture console directly.
function captureConsole() {
  let buf = "";
  const sink = (...a: unknown[]) => {
    buf += a.map(String).join(" ") + "\n";
  };
  const log = vi.spyOn(console, "log").mockImplementation(sink);
  const error = vi.spyOn(console, "error").mockImplementation(sink);
  return {
    text: () => buf.replace(/\[[0-9;]*m/g, ""),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

let fetchStub: FetchStub | undefined;
let con: ReturnType<typeof captureConsole>;

beforeEach(() => {
  h.hasDocker = true;
  h.composeUpResult = { ok: true, apiPort: "4000", dashPort: "3001" };
  h.prefetchOk = true;
  h.prefetchCalls = 0;
  h.composeUpCalls = 0;
  h.internalToken = "tok";
  e.plan = { proceed: true };
  e.calls = 0;
  e.rollbacks = 0;
  e.completes = 0;
  e.restored = true;
  e.edgeBroken = false;
  e.edgeCrashReason = null;
  // Clear any option values commander retained from a previous parse.
  (upCommand as any).setOptionValue?.("edge", undefined);
  (upCommand as any).setOptionValue?.("compose", undefined);
  con = captureConsole();
});

afterEach(() => {
  con.restore();
  fetchStub?.restore();
  fetchStub = undefined;
  vi.restoreAllMocks();
});

describe("openship up --compose (edge chain)", () => {
  it("exits before the edge preflight when docker/compose is missing", async () => {
    h.hasDocker = false;
    const r = await runCommand(upCommand, ["--compose"]);
    expect(r.code).toBe(1);
    expect(e.calls).toBe(0); // gate is first
    expect(h.composeUpCalls).toBe(0);
    expect(con.text()).toContain("docker compose");
  });

  it("brings the stack up when the edge is clean", async () => {
    e.plan = { proceed: true };
    const r = await runCommand(upCommand, ["--compose"]);
    expect(e.calls).toBe(1);
    expect(h.composeUpCalls).toBe(1);
    expect(r.code).toBe(0);
  });

  it("does NOT bring the stack up when the user cancels the edge takeover", async () => {
    e.plan = { proceed: false };
    const r = await runCommand(upCommand, ["--compose"]);
    expect(e.calls).toBe(1);
    expect(h.composeUpCalls).toBe(0);
    expect(r.code).toBe(1);
    expect(con.text()).toContain("Left the existing proxy");
  });

  it("imports migrated sites into the edge after the stack is healthy", async () => {
    e.plan = {
      proceed: true,
      action: "migrate",
      sites: [{ serverNames: ["a.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } }],
      certPems: { "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } },
    };
    fetchStub = stubFetch((req) => {
      if (req.url.endsWith("/api/health")) return { status: 200, json: { ok: true } };
      if (req.url.endsWith("/api/system/edge/import-sites")) return { status: 200, json: { registered: ["a.com"], warnings: [] } };
      return { status: 404, json: {} };
    });

    const r = await runCommand(upCommand, ["--compose"]);
    expect(r.code).toBe(0);
    expect(h.composeUpCalls).toBe(1);

    const importCall = fetchStub.calls.find((c) => c.url.endsWith("/api/system/edge/import-sites"));
    expect(importCall).toBeDefined();
    expect(importCall!.method).toBe("POST");
    expect(importCall!.headers["x-internal-token"]).toBe("tok");
    expect((importCall!.body as any).sites).toHaveLength(1);
    expect((importCall!.body as any).certPems).toEqual({ "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } });
    // Edge is serving → the takeover journal is closed, so the NEXT run doesn't
    // read it as interrupted and restart the proxy we just replaced.
    expect(e.completes).toBe(1);
    expect(e.rollbacks).toBe(0);
  });

  // The onvo.me run: compose "succeeded" (the container was CREATED), the edge was
  // crash-looping on a bad conf, nginx was already stopped — so 6 hostnames were
  // dark and the CLI walked on into an import that could only 409.
  // Downtime = how long the box is dark. Pulling ~500MB AFTER stopping nginx meant
  // minutes of it, and a failed pull took their sites down for a problem that hadn't
  // touched them yet.
  it("fetches images BEFORE the preflight touches :80/:443", async () => {
    e.plan = { proceed: true, action: "migrate", sites: [] };
    fetchStub = stubFetch(() => ({ status: 200, json: { ok: true } }));

    await runCommand(upCommand, ["--compose"]);

    expect(h.prefetchCalls).toBe(1);
    expect(e.calls).toBe(1);
    // The preflight (which stops their proxy) must not have run first.
    expect(h.prefetchCalls).toBeGreaterThan(0);
  });

  it("never touches their proxy when the images can't be fetched", async () => {
    h.prefetchOk = false;

    const r = await runCommand(upCommand, ["--compose"]);

    expect(r.code).toBe(1);
    // Nothing stopped, nothing to roll back, box still serving.
    expect(e.calls).toBe(0);
    expect(e.rollbacks).toBe(0);
    expect(h.composeUpCalls).toBe(0);
  });

  it("RESTORES the proxy when the edge container is crash-looping", async () => {
    e.plan = { proceed: true, action: "migrate", sites: [{ serverNames: ["a.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } }] };
    e.edgeBroken = true;
    e.edgeCrashReason = "a duplicate default server for 0.0.0.0:80";
    fetchStub = stubFetch(() => ({ status: 200, json: { ok: true } }));

    const r = await runCommand(upCommand, ["--compose"]);

    expect(r.code).toBe(1);
    expect(e.rollbacks).toBe(1);
    // The journal must stay OPEN — it's the record of how to restart their proxy.
    expect(e.completes).toBe(0);
    // No import attempted against an edge that can't serve it.
    expect(fetchStub.calls.some((c) => c.url.endsWith("/api/system/edge/import-sites"))).toBe(false);
    // (The operator-facing text goes through console.error, which this harness
    // doesn't capture — same as the existing bring-up-failure test above.)
  });

  it("RESTORES the proxy when the stack fails to come up after a takeover", async () => {
    // The hekai run: preflight stopped + disabled nginx, then `docker compose pull`
    // died on a registry error. Without a rollback the box stays dark with the
    // operator's proxy stopped AND disabled (it wouldn't even survive a reboot).
    e.plan = { proceed: true, action: "takeover" };
    h.composeUpResult = { ok: false, apiPort: "4000", dashPort: "3001" };

    const r = await runCommand(upCommand, ["--compose"]);
    expect(r.code).toBe(1);
    expect(e.rollbacks).toBe(1);
    expect(e.completes).toBe(0);
    expect(con.text()).toMatch(/Restored the previous proxy/i);
  });

  it("does not roll back a failed bring-up when nothing was taken over", async () => {
    e.plan = { proceed: true }; // edge was free — we never stopped anything
    h.composeUpResult = { ok: false, apiPort: "4000", dashPort: "3001" };

    await runCommand(upCommand, ["--compose"]);
    expect(e.rollbacks).toBe(0);
  });

  it("rejects an invalid --edge value before any side effects", async () => {
    const r = await runCommand(upCommand, ["--compose", "--edge", "bogus"]);
    expect(r.code).toBe(1);
    expect(e.calls).toBe(0);
    expect(h.composeUpCalls).toBe(0);
    expect(con.text()).toContain("Invalid --edge");
  });
});
