import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI's half of port resolution: what it PERSISTS and what it PRINTS.
 *
 * The algorithm (occupied → neighbour, reclaimable, bindAddr) is shared with the
 * desktop app and tested against it in packages/core/src/ports.test.ts. What's
 * asserted here is the wiring only this side has: ports.json as the remembered
 * pair, the documented 4000/3001 defaults reaching the resolver, and the
 * operator-facing lines for a port that moved.
 */

// OS_DIR is resolved at import time from OPENSHIP_HOME — point it at a temp dir
// before loading the module so the tests never touch a real ~/.openship.
const home = mkdtempSync(join(tmpdir(), "openship-ports-"));
process.env.OPENSHIP_HOME = home;
const PORTS_FILE = join(home, "ports.json");

const { resolvePorts, isPortFree, getFreePort, portMoveNotice, stalePortOrigins } = await import(
  "../../src/lib/ports"
);

/** A port this box genuinely has free, plus its neighbour. */
async function freePair(): Promise<{ port: number; next: number }> {
  for (let i = 0; i < 50; i++) {
    const port = await getFreePort();
    if (await isPortFree(port + 1)) return { port, next: port + 1 };
  }
  throw new Error("no adjacent free ports available");
}

beforeEach(() => {
  rmSync(PORTS_FILE, { force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolvePorts", () => {
  it("keeps a free preference (a stable origin is what keeps you logged in)", async () => {
    const { port } = await freePair();
    const dash = await getFreePort();

    const r = await resolvePorts({ api: port, dashboard: dash });

    expect(r.api).toBe(port);
    expect(r.dashboard).toBe(dash);
    expect(r.switched).toEqual({ api: false, dashboard: false });
  });




  it("ranks an explicit flag over the install's config and ports.json", async () => {
    const flag = await getFreePort();
    writeFileSync(PORTS_FILE, JSON.stringify({ api: 4000, dashboard: 3001 }));

    const r = await resolvePorts({
      api: flag,
      previous: { api: 4321, dashboard: 3210 },
      dashboard: await getFreePort(),
    });

    expect(r.api).toBe(flag);
  });

  it("ranks the install's own config over a stale ports.json", async () => {
    // A compose install's `.env` is what its containers actually publish; ports.json
    // may be a leftover from a bare install on the same box.
    const configured = await getFreePort();
    writeFileSync(PORTS_FILE, JSON.stringify({ api: 4000, dashboard: 3001 }));

    const r = await resolvePorts({ previous: { api: configured } });

    expect(r.api).toBe(configured);
    expect(r.switched.api).toBe(false);
  });

  it("supplies the documented 4000/3001 defaults when asked for nothing", async () => {
    // The CLI's contract, and the one place it differs from the desktop app (which
    // passes no defaults so it never collides with a dev server). Asserted on the
    // PREFERENCE, since 4000/3001 may legitimately be busy on this machine.
    const r = await resolvePorts({});

    expect(r.preferred).toEqual({ api: 4000, dashboard: 3001 });
  });

  it("persists the result so doctor / reset-admin find the instance", async () => {
    const { port } = await freePair();

    const r = await resolvePorts({ api: port, dashboard: await getFreePort() });

    expect(JSON.parse((await import("node:fs")).readFileSync(PORTS_FILE, "utf8"))).toEqual({
      api: r.api,
      dashboard: r.dashboard,
    });
  });

});

describe("portMoveNotice", () => {
  const moved = {
    api: 4000,
    dashboard: 3002,
    switched: { api: false, dashboard: true },
    preferred: { api: 4000, dashboard: 3001 },
  };

  it("says nothing when nothing moved", () => {
    expect(
      portMoveNotice({
        api: 4000,
        dashboard: 3001,
        switched: { api: false, dashboard: false },
        preferred: { api: 4000, dashboard: 3001 },
      }),
    ).toEqual([]);
  });

  it("reports where the ports landed", () => {
    expect(portMoveNotice(moved)[0]).toContain("API 4000, dashboard 3002");
  });

  it("adds the ORIGIN_REJECTED warning for an origin left on the old port", () => {
    const text = portMoveNotice(moved, ["http://10.0.0.4:3001"]).join(" ");
    expect(text).toContain("http://10.0.0.4:3001");
    expect(text).toContain("still names port 3001");
    expect(text).toContain(":3002");
  });

  it("does not repeat the same origin twice", () => {
    const text = portMoveNotice(moved, [
      "http://10.0.0.4:3001",
      "http://10.0.0.4:3001",
    ]).join(" ");
    expect(text.match(/10\.0\.0\.4:3001/g)).toHaveLength(1);
  });
});

describe("stalePortOrigins", () => {
  it("flags an origin pinned to the port the dashboard moved off", () => {
    expect(stalePortOrigins(3001, ["http://192.168.1.50:3001"])).toEqual([
      "http://192.168.1.50:3001",
    ]);
  });

  it("splits a comma-separated trusted-origins list", () => {
    expect(
      stalePortOrigins(3001, ["https://ops.example.com, http://10.0.0.4:3001"]),
    ).toEqual(["http://10.0.0.4:3001"]);
  });

  it("leaves a front proxy's own port alone", () => {
    // The public URL's port belongs to whatever terminates TLS, not to the
    // dashboard — "different from the dashboard port" is normal, not stale.
    expect(stalePortOrigins(3001, ["https://ops.example.com:8443"])).toEqual([]);
  });

  it("ignores portless URLs and junk", () => {
    expect(stalePortOrigins(3001, ["https://ops.example.com", "not a url", "", undefined])).toEqual(
      [],
    );
  });
});
