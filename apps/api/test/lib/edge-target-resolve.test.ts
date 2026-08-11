import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveEdgeTargetHost` decides what address Openship Cloud's shared edge dials
 * for a free `<slug>.opsh.io` route. These tests pin the ORDERING, which is the
 * whole behaviour: DECLARED beats GUESSED, and an IP breaks the tie among declared.
 *
 * Both halves matter and they pull opposite ways:
 *
 * A declared name SERVES FINE — the edge forwards `Host: <slug>.opsh.io`, so any
 * address reaching the box on :80 works and OpenResty matches the vhost on the Host
 * header. It's preferred over a probed IP because the probe reports the box's
 * EGRESS address, which on a NAT'd / load-balanced / floating-IP host is not the
 * inbound one; ranking the guess higher would break routes that serve today.
 *
 * A declared IP is still preferred over a declared name, because the edge
 * re-resolves a name per request — a CDN later placed in front of it (no zone for
 * `<slug>.opsh.io`) or an https redirect on it silently stops the free URL working.
 */

const { mockEnv, getInOrganization, findLocal, getInstanceReachability, resolveLocalServerHost, resolveInstancePublicIp } =
  vi.hoisted(() => ({
    mockEnv: {
      OPENSHIP_PUBLIC_URL: undefined as string | undefined,
      SERVER_IP: undefined as string | undefined,
      HOST_DOMAIN: undefined as string | undefined,
    },
    getInOrganization: vi.fn(),
    findLocal: vi.fn(),
    getInstanceReachability: vi.fn(),
    resolveLocalServerHost: vi.fn(),
    resolveInstancePublicIp: vi.fn(),
  }));

vi.mock("../../src/config/env", () => ({ env: mockEnv }));
vi.mock("@repo/db", () => ({ repos: { server: { getInOrganization, findLocal } } }));
vi.mock("../../src/lib/public-url", () => ({ getInstanceReachability }));
vi.mock("../../src/lib/server-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/server-target")>()),
  resolveLocalServerHost,
  resolveInstancePublicIp,
}));

import { resolveEdgeTargetHost } from "../../src/lib/edge-target";

const ORG = "org_1";

/**
 * The public-IP probe is memoized for 5 minutes (it's 3 sequential HTTP echoes and
 * free-domain sync loops over a project's domains). That cache is module state, so
 * each test jumps the clock past the TTL to get its own answer — without this, one
 * test's probed IP silently answers the next one's assertions.
 */
let clock = new Date(2026, 0, 1, 0, 0, 0).getTime();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 10 * 60_000;
  vi.setSystemTime(clock);
  mockEnv.OPENSHIP_PUBLIC_URL = undefined;
  mockEnv.SERVER_IP = undefined;
  mockEnv.HOST_DOMAIN = undefined;
  getInOrganization.mockResolvedValue(null);
  findLocal.mockResolvedValue(null);
  getInstanceReachability.mockResolvedValue(null);
  resolveLocalServerHost.mockResolvedValue(null);
  resolveInstancePublicIp.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveEdgeTargetHost — a declared IP wins", () => {
  it("prefers an explicit SERVER_IP over a declared hostname", async () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://hekai.org";
    mockEnv.SERVER_IP = "198.51.100.7";

    const result = await resolveEdgeTargetHost(ORG);

    expect(result.host).toBe("198.51.100.7");
    expect(result.warning).toBeUndefined();
  });

  it("takes an IP literal out of OPENSHIP_PUBLIC_URL, and never probes", async () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://203.0.113.10:8443/x";

    expect((await resolveEdgeTargetHost(ORG)).host).toBe("203.0.113.10");
    expect(resolveLocalServerHost).not.toHaveBeenCalled();
    expect(resolveInstancePublicIp).not.toHaveBeenCalled();
  });

  it("prefers a caller-supplied IP (setup's --public-url) over env", async () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://hekai.org";

    const result = await resolveEdgeTargetHost(ORG, { preferHost: "198.51.100.7" });

    expect(result.host).toBe("198.51.100.7");
  });
});

describe("resolveEdgeTargetHost — a declared name beats a PROBED ip", () => {
  it("keeps the declared hostname even when the box has a registered IP", async () => {
    // The route this produces is the one that has been serving port-based apps
    // correctly. Swapping it for the probe's answer — the box's EGRESS address,
    // which on a NAT'd/load-balanced host is not the inbound one — would break a
    // working setup to satisfy a preference.
    mockEnv.OPENSHIP_PUBLIC_URL = "https://hekai.org";
    resolveLocalServerHost.mockResolvedValue("203.0.113.10");

    const result = await resolveEdgeTargetHost(ORG);

    expect(result.host).toBe("hekai.org");
    expect(result.warning).toMatch(/SERVER_IP/);
  });

  it("does not spend a probe when a name was declared", async () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://hekai.org";

    await resolveEdgeTargetHost(ORG);

    expect(resolveInstancePublicIp).not.toHaveBeenCalled();
  });

  it("keeps the verified self-app domain over a registered IP", async () => {
    getInstanceReachability.mockResolvedValue({ url: "https://apps.hekai.org" });
    resolveLocalServerHost.mockResolvedValue("203.0.113.10");

    expect((await resolveEdgeTargetHost(ORG)).host).toBe("apps.hekai.org");
  });

  it("reads a hostname target as serving, not as a defect", async () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://hekai.org";

    const result = await resolveEdgeTargetHost(ORG);

    expect(result.reason).toBeUndefined();
    expect(result.warning).toMatch(/serves fine/);
  });
});

describe("resolveEdgeTargetHost — a probed IP is the last resort", () => {
  it("uses the box's registered IP when nothing was declared", async () => {
    resolveLocalServerHost.mockResolvedValue("203.0.113.10");

    const result = await resolveEdgeTargetHost(ORG);

    expect(result.host).toBe("203.0.113.10");
    expect(result.warning).toBeUndefined();
  });

  it("live-probes when the stored row holds a hostname rather than an IP", async () => {
    // self-server.ts prefers HOST_DOMAIN for the row's DISPLAY host, so a box can
    // have a name stored where its IP would be.
    resolveLocalServerHost.mockResolvedValue("stored.example.com");
    resolveInstancePublicIp.mockResolvedValue("203.0.113.10");

    expect((await resolveEdgeTargetHost(ORG)).host).toBe("203.0.113.10");
  });

  it("ignores a probe result that is not publicly routable", async () => {
    resolveInstancePublicIp.mockResolvedValue("192.168.1.50");

    const result = await resolveEdgeTargetHost(ORG);

    expect(result.host).toBeNull();
    expect(result.reason).toContain("no public address");
  });

  it("never returns a `.opsh.io` host as the target, even as the last resort", async () => {
    // A free-domain install sets OPENSHIP_PUBLIC_URL to the free URL itself; using
    // it would make the edge forward into itself.
    mockEnv.OPENSHIP_PUBLIC_URL = "https://sadsa.opsh.io";

    const result = await resolveEdgeTargetHost(ORG);

    expect(result.host).toBeNull();
    expect(result.reason).toContain("Openship Cloud edge");
  });

  it("reports no public address when there is genuinely nothing", async () => {
    const result = await resolveEdgeTargetHost(ORG);

    expect(result.host).toBeNull();
    expect(result.reason).toContain("no public address");
  });
});

describe("resolveEdgeTargetHost — a remote server row", () => {
  it("uses the row's address and does not consult this box's env or IP", async () => {
    mockEnv.SERVER_IP = "198.51.100.7";
    getInOrganization.mockResolvedValue({ isLocal: false, sshHost: "203.0.113.55" });

    const result = await resolveEdgeTargetHost(ORG, { serverId: "srv_1" });

    expect(result.host).toBe("203.0.113.55");
    expect(result.warning).toBeUndefined();
  });

  it("flags a remote row addressed by hostname — we can't probe ITS public IP", async () => {
    getInOrganization.mockResolvedValue({ isLocal: false, sshHost: "box.hekai.org" });

    const result = await resolveEdgeTargetHost(ORG, { serverId: "srv_1" });

    expect(result.host).toBe("box.hekai.org");
    expect(result.warning).toContain("Settings → Servers");
  });

  it("falls through to the instance's own IP for an isLocal row", async () => {
    // The local row's sshHost is display-only (`127.0.0.1` when nothing better was
    // known), which is exactly what made the edge proxy to its own loopback.
    getInOrganization.mockResolvedValue({ isLocal: true, sshHost: "127.0.0.1" });
    resolveLocalServerHost.mockResolvedValue("203.0.113.10");

    expect((await resolveEdgeTargetHost(ORG, { serverId: "srv_1" })).host).toBe("203.0.113.10");
  });

  it("refuses a remote row pointed at a private address", async () => {
    getInOrganization.mockResolvedValue({ isLocal: false, sshHost: "10.0.0.5" });

    const result = await resolveEdgeTargetHost(ORG, { serverId: "srv_1" });

    expect(result.host).toBeNull();
    expect(result.reason).toContain("not publicly reachable");
  });
});
