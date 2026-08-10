import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";

import {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  findPortNear,
  getFreePort,
  isPortFree,
  resolvePortPair,
} from "./ports";

/**
 * The resolver both launchers share. Two behaviours matter more than the happy
 * path:
 *
 *  - what must NOT move. A running install HOLDS its own ports, so "busy" alone
 *    can't mean "take another one" — otherwise every re-run walks the box to a new
 *    origin, logging everyone out (cookies are bound to `localhost:<port>`).
 *  - the no-`defaults` mode. The desktop app must never land on 4000/3001, where a
 *    dev server lives, so it passes no defaults and expects free ports.
 */

const held: Server[] = [];

/** Occupy a port the way a foreign process would, for one test. */
function occupy(port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, host, () => {
      held.push(srv);
      resolve();
    });
  });
}

/** Two adjacent free ports, so "steps to the neighbour" is a real assertion. */
async function freePair(): Promise<{ port: number; next: number }> {
  for (let i = 0; i < 50; i++) {
    const port = await getFreePort();
    if (await isPortFree(port + 1)) return { port, next: port + 1 };
  }
  throw new Error("no adjacent free ports available");
}

/** A free port clear of `exclude` — the resolver also steers a moved service away
 *  from the sibling's preference, which would otherwise skew these assertions. */
async function freePortAway(exclude: number[]): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = await getFreePort();
    if (!exclude.some((p) => Math.abs(p - port) <= 1)) return port;
  }
  throw new Error("no free port clear of the excluded range");
}

afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("resolvePortPair", () => {
  it("keeps a free preference (a stable origin is what keeps you logged in)", async () => {
    const api = await getFreePort();
    const dashboard = await freePortAway([api]);

    const r = await resolvePortPair({ api, dashboard });

    expect(r).toMatchObject({ api, dashboard, switched: { api: false, dashboard: false } });
  });

  it("moves off an occupied preference to the nearest neighbour", async () => {
    // Neighbour, not an OS-assigned ephemeral port: a moved port is operator-facing
    // on a server install (browsed, firewalled, written into a proxy config).
    const { port, next } = await freePair();
    await occupy(port);

    const r = await resolvePortPair({ api: port, dashboard: await freePortAway([port, next]) });

    expect(r.api).toBe(next);
    expect(r.switched.api).toBe(true);
    expect(r.preferred.api).toBe(port);
  });

  it("keeps a busy port that OUR OWN install holds", async () => {
    // The compose re-run: the api container is on this port right now and `up -d`
    // recreates it there. Treating that as occupied is what moved the install.
    const { port } = await freePair();
    await occupy(port);

    const r = await resolvePortPair({
      api: port,
      dashboard: await freePortAway([port]),
      reclaimable: [port],
    });

    expect(r.api).toBe(port);
    expect(r.switched.api).toBe(false);
  });

  it("never lands a moved service on a port our stack holds for another one", async () => {
    const { port, next } = await freePair();
    await occupy(port);
    await occupy(next);

    const r = await resolvePortPair({ api: port, dashboard: next, reclaimable: [next] });

    expect(r.dashboard).toBe(next);
    expect(r.api).not.toBe(next);
  });

  it("ranks explicit over the install's config over the remembered pair", async () => {
    const explicit = await getFreePort();

    expect(
      (
        await resolvePortPair({
          api: explicit,
          previous: { api: 4321 },
          stored: { api: 4322 },
          dashboard: await freePortAway([explicit]),
        })
      ).api,
    ).toBe(explicit);

    const configured = await getFreePort();
    expect(
      (await resolvePortPair({ previous: { api: configured }, stored: { api: 4322 } })).api,
    ).toBe(configured);
  });

  it("falls back to the caller's defaults when nothing else applies", async () => {
    const r = await resolvePortPair({
      defaults: { api: DEFAULT_API_PORT, dashboard: DEFAULT_DASHBOARD_PORT },
    });
    // 4000/3001 may legitimately be busy on the machine running the tests, in which
    // case the resolver moves — what's asserted is that they were the PREFERENCE.
    expect(r.preferred).toEqual({ api: DEFAULT_API_PORT, dashboard: DEFAULT_DASHBOARD_PORT });
  });

  it("hands out free ports (never 4000/3001) when given no defaults", async () => {
    // The desktop app: a packaged build must not fight a dev server, and its users
    // never type the port.
    const r = await resolvePortPair();

    expect(r.api).not.toBe(DEFAULT_API_PORT);
    expect(r.dashboard).not.toBe(DEFAULT_DASHBOARD_PORT);
    expect(r.api).not.toBe(r.dashboard);
    expect(r.switched).toEqual({ api: false, dashboard: false });
  });

  it("reuses the remembered pair with no defaults (the desktop restart)", async () => {
    const stored = { api: await getFreePort(), dashboard: 0 };
    stored.dashboard = await freePortAway([stored.api]);

    const r = await resolvePortPair({ stored });

    expect(r).toMatchObject({ api: stored.api, dashboard: stored.dashboard });
  });

  it("keeps the two ports distinct even when asked for the same one twice", async () => {
    const { port } = await freePair();

    const r = await resolvePortPair({ api: port, dashboard: port });

    expect(r.api).toBe(port);
    expect(r.dashboard).not.toBe(port);
  });
});

describe("findPortNear", () => {
  it("skips ports the caller excluded", async () => {
    const { port, next } = await freePair();

    const found = await findPortNear(port, { skip: (p) => p === port || p === next });

    expect(found).not.toBe(port);
    expect(found).not.toBe(next);
  });
});
