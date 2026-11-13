import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-running `openship up` while its own service is running (#1570).
 *
 * The running service holds the ports in ports.json, so they probe busy. They are
 * still ours: installAndStart replaces that instance before the new one binds.
 * Treating them as taken moved the install to new ports on every re-run
 * (7100 -> 7101), rewrote ports.json, and first sat out waitPortFree on each port.
 */

// lib/paths reads OPENSHIP_HOME at import time, so set it before anything loads.
const HOME = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, "") || "/tmp"}/openship-up-rerun-${process.pid}`;
  process.env.OPENSHIP_HOME = dir;
  return dir;
});

const svc = vi.hoisted(() => ({
  running: false,
  installed: [] as Array<{ port: string; dashboardPort: string }>,
}));

// Only the service manager is faked. The port resolver and ports.json stay real.
vi.mock("../../src/lib/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/service")>()),
  serviceStatus: () => ({ kind: "launchd", installed: true, running: svc.running }),
  installAndStart: (flags: { port: string; dashboardPort: string }) => {
    svc.installed.push(flags);
    return { kind: "launchd", detail: "test" };
  },
}));

const { startService } = await import("../../src/commands/up");
const { getFreePort, isPortFree } = await import("../../src/lib/ports");

const PORTS_FILE = join(HOME, "ports.json");
const held: Server[] = [];

/** Bind a port the way a running process would. */
function hold(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      held.push(srv);
      resolve();
    });
  });
}

/** A free port whose neighbour is free too, so a move to it would be visible. */
async function freeWithNeighbour(from?: number): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = from === undefined ? await getFreePort() : from + i * 3;
    if ((await isPortFree(port)) && (await isPortFree(port + 1))) return port;
  }
  throw new Error("no free port with a free neighbour");
}

/** API and dashboard ports far enough apart that neither move lands on the other. */
async function freePorts(): Promise<{ api: number; dashboard: number }> {
  const api = await freeWithNeighbour();
  return { api, dashboard: await freeWithNeighbour(api + 10) };
}

beforeEach(() => {
  mkdirSync(HOME, { recursive: true });
  rmSync(PORTS_FILE, { force: true });
  svc.running = false;
  svc.installed = [];
});

afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("startService on a re-run", () => {
  it("keeps the ports its own running service holds", async () => {
    const { api, dashboard } = await freePorts();
    writeFileSync(PORTS_FILE, JSON.stringify({ api, dashboard }));
    await hold(api);
    await hold(dashboard);
    svc.running = true;

    const r = await startService({}, { quiet: true });

    expect({ api: r.port, dashboard: r.dashPort }).toEqual({
      api: String(api),
      dashboard: String(dashboard),
    });
    expect(svc.installed[0]).toMatchObject({ port: String(api), dashboardPort: String(dashboard) });
    expect(JSON.parse(readFileSync(PORTS_FILE, "utf8"))).toEqual({ api, dashboard });
  }, 30_000);

  it("still moves off a remembered port another program holds when the service is not running", async () => {
    const { api, dashboard } = await freePorts();
    writeFileSync(PORTS_FILE, JSON.stringify({ api, dashboard }));
    await hold(api);

    const r = await startService({}, { quiet: true });

    expect(r.port).not.toBe(String(api));
    expect(r.dashPort).toBe(String(dashboard));
  }, 30_000);
});
