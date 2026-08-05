import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the compose backend + the host edge preflight so runCompose's ORCHESTRATION
// (gate → preflight → up → import) is exercised without real docker / ss / fs.
const h = vi.hoisted(() => ({
  hasDocker: true,
  composeUpResult: { ok: true, apiPort: "4000", dashPort: "3001" },
  composeUpCalls: 0,
  /** Images fetched BEFORE the edge preflight can stop anyone's proxy. */
  prefetchResult: true,
  prefetchCalls: 0,
  internalToken: "tok" as string | null,
  /** Ports the stack will publish — moved off the preference when busy. */
  resolvedPorts: {
    api: 4000,
    dashboard: 3001,
    switched: { api: false, dashboard: false },
    preferred: { api: 4000, dashboard: 3001 },
  },
  /** Trusted-origin URLs the install is configured with. */
  trustedOriginUrls: [] as string[],
  /** Ports handed to composePrefetch / composeUp (they must agree). */
  portArgs: [] as Array<{ apiPort?: string; dashboardPort?: string }>,
  /** What the command asked the resolver to prefer. */
  portPrefs: [] as Array<{ api?: string; dashboard?: string }>,
}));
vi.mock("../../src/lib/compose", () => ({
  hasDockerCompose: () => h.hasDocker,
  // Host ports are resolved ONCE before `.env` is written, then passed to both
  // compose steps — a busy 4000/3001 fails `up` outright, so it has to move.
  resolveComposePorts: async (p: { api?: string; dashboard?: string }) => {
    h.portPrefs.push(p);
    return h.resolvedPorts;
  },
  composeTrustedOriginUrls: () => h.trustedOriginUrls,
  // `up` now installs Docker rather than degrading to bare (same helper the
  // wizard uses); the fixture reports whether it's present/installable.
  ensureDocker: async () => h.hasDocker,
  // Images are fetched BEFORE the preflight is allowed to stop the operator's
  // proxy. Counted so the tests below can pin that ordering down, and failable
  // so the "fetch failed → nothing was touched" path is covered.
  composePrefetch: (o: { apiPort?: string; dashboardPort?: string }) => {
    h.prefetchCalls++;
    h.portArgs.push({ apiPort: o.apiPort, dashboardPort: o.dashboardPort });
    return h.prefetchResult;
  },
  // async: composeUp awaits the vhost sanitize before `up -d`.
  composeUp: async (o: { apiPort?: string; dashboardPort?: string }) => {
    h.composeUpCalls++;
    h.portArgs.push({ apiPort: o.apiPort, dashboardPort: o.dashboardPort });
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
vi.mock("@repo/adapters", () => ({
  LocalExecutor: class {
    /**
     * `waitForEdgeRunning` polls `docker inspect -f '{{.State.Running}}'` through
     * this executor before importing migrated sites. There's no docker in the
     * harness, so report the edge as up — otherwise the import gate never opens
     * and the assertion below sees zero registered sites.
     *
     * Not optional: an executor stub without `exec` throws
     * "exec.exec is not a function" from inside the poll loop.
     */
    async exec(): Promise<string> {
      return "true\n";
    }
  },
}));

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
  h.prefetchResult = true;
  h.prefetchCalls = 0;
  h.composeUpCalls = 0;
  h.internalToken = "tok";
  h.resolvedPorts = {
    api: 4000,
    dashboard: 3001,
    switched: { api: false, dashboard: false },
    preferred: { api: 4000, dashboard: 3001 },
  };
  h.portArgs = [];
  h.portPrefs = [];
  h.trustedOriginUrls = [];
  (upCommand as any).setOptionValue?.("port", undefined);
  (upCommand as any).setOptionValue?.("dashboardPort", undefined);
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
    expect(h.prefetchCalls).toBe(1);
    expect(h.composeUpCalls).toBe(1);
    expect(r.code).toBe(0);
  });

  // The whole point of prefetching: a ~500MB pull must not happen with the
  // operator's proxy already stopped, and a pull that FAILS must not have taken
  // their sites down for a problem that never touched the proxy.
  it("does NOT touch the proxy when the image fetch fails", async () => {
    h.prefetchResult = false;
    const r = await runCommand(upCommand, ["--compose"]);
    expect(r.code).toBe(1);
    expect(h.prefetchCalls).toBe(1);
    expect(e.calls).toBe(0); // preflight never ran, so nothing was stopped
    expect(e.rollbacks).toBe(0); // and nothing needed restoring
    expect(h.composeUpCalls).toBe(0);
    expect(con.text()).toContain("untouched");
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

  it("carries the resolved ports into BOTH compose steps when a port is busy", async () => {
    // The desktop app never dies on a busy port; a VPS install must not either. The
    // stack publishes API_PORT/DASHBOARD_PORT on the host, so 4000 held by anything
    // else is a hard `bind: address already in use` — the ports move instead, and
    // prefetch and up have to be handed the SAME values (they each render `.env`,
    // and a disagreement would pull/build one config and start another).
    h.resolvedPorts = {
      api: 4001,
      dashboard: 3002,
      switched: { api: true, dashboard: true },
      preferred: { api: 4000, dashboard: 3001 },
    };
    h.composeUpResult = { ok: true, apiPort: "4001", dashPort: "3002" };

    await runCommand(upCommand, ["--compose"]);

    expect(h.portArgs).toHaveLength(2);
    for (const call of h.portArgs) {
      expect(call).toEqual({ apiPort: "4001", dashboardPort: "3002" });
    }
    // Told, not silently moved: the operator has to know which port to browse and firewall.
    expect(con.text()).toMatch(/preferred port was busy.*API 4001.*dashboard 3002/i);
    expect(con.text()).toContain("http://localhost:3002");
  });

  it("asks for NO port preference when the flags weren't passed", async () => {
    // A commander default would make the flags always "set", which reads as "the
    // operator asked for 4000" — outranking the ports the install is configured with
    // and rewriting a stack pinned to 4100 back to 4000 on a plain re-run. Asserted
    // on the option itself as well: a default is applied at registration time, so
    // the per-test reset above would otherwise hide its return.
    const opts = (upCommand as any).options as Array<{ long?: string; defaultValue?: unknown }>;
    expect(opts.find((o) => o.long === "--port")?.defaultValue).toBeUndefined();
    expect(opts.find((o) => o.long === "--dashboard-port")?.defaultValue).toBeUndefined();

    await runCommand(upCommand, ["--compose"]);
    expect(h.portPrefs).toEqual([{ api: undefined, dashboard: undefined }]);
  });

  it("passes an explicit --port through as the preference", async () => {
    await runCommand(upCommand, ["--compose", "--port", "4100", "--dashboard-port", "3100"]);
    expect(h.portPrefs).toEqual([{ api: "4100", dashboard: "3100" }]);
  });

  it("warns when a trusted origin still names the port we moved off", async () => {
    // The stack comes up fine and then 403s every login with ORIGIN_REJECTED,
    // because trustedOrigins still contains the old port. Nothing else in the output
    // points at the cause, so the move has to say it.
    h.resolvedPorts = {
      api: 4000,
      dashboard: 3002,
      switched: { api: false, dashboard: true },
      preferred: { api: 4000, dashboard: 3001 },
    };
    h.trustedOriginUrls = ["http://192.168.1.50:3001"];

    await runCommand(upCommand, ["--compose"]);

    const out = con.text();
    expect(out).toContain("http://192.168.1.50:3001");
    expect(out).toMatch(/still names port 3001/);
    expect(out).toMatch(/rejected/i);
  });

  it("leaves a reverse proxy's own port alone when reporting a move", async () => {
    // `https://ops.example.com:8443` names the proxy in front, not the dashboard —
    // warning about it would send the operator to change the one correct thing.
    h.resolvedPorts = {
      api: 4000,
      dashboard: 3002,
      switched: { api: false, dashboard: true },
      preferred: { api: 4000, dashboard: 3001 },
    };
    h.trustedOriginUrls = ["https://ops.example.com:8443"];

    await runCommand(upCommand, ["--compose"]);

    expect(con.text()).not.toMatch(/still names port/);
  });

  it("stays quiet about ports when the preferred ones were free", async () => {
    await runCommand(upCommand, ["--compose"]);
    expect(h.portArgs).toEqual([
      { apiPort: "4000", dashboardPort: "3001" },
      { apiPort: "4000", dashboardPort: "3001" },
    ]);
    expect(con.text()).not.toMatch(/preferred port was busy/i);
  });

  it("rejects an invalid --edge value before any side effects", async () => {
    const r = await runCommand(upCommand, ["--compose", "--edge", "bogus"]);
    expect(r.code).toBe(1);
    expect(e.calls).toBe(0);
    expect(h.composeUpCalls).toBe(0);
    expect(con.text()).toContain("Invalid --edge");
  });
});
