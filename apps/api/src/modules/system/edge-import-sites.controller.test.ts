import { describe, it, expect, beforeEach, vi } from "vitest";

// Override ONLY `platform` (keep the real assertNotCloud); the handler drives the
// real `registerImportedSites` against these provider doubles, so this exercises
// the actual wiring, not a re-implementation.
const H = vi.hoisted(() => ({
  platform: null as { routing: any; ssl: any; executor: unknown } | null,
}));
vi.mock("../../lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/controller-helpers")>();
  return { ...actual, platform: () => H.platform };
});

import { edgeImportSites } from "./self-app.controller";

type Res = { __data: any; __status: number };
function ctx(opts: { body?: unknown; throwJson?: boolean }): any {
  return {
    req: {
      json: async () => {
        if (opts.throwJson) throw new Error("bad json");
        return opts.body;
      },
    },
    json: (data: any, status = 200): Res => ({ __data: data, __status: status }),
  };
}

function fakePlatform() {
  const routing = { registerRoute: vi.fn(async () => {}), removeRoute: vi.fn(async () => {}) };
  const ssl = {
    provisionCert: vi.fn(async () => ({ verified: true })),
    installCert: vi.fn(async () => ({ verified: true })),
    renewCert: vi.fn(async () => ({ verified: true })),
    verifyCert: vi.fn(async () => ({ verified: true })),
  };
  return { routing, ssl, executor: {} };
}

beforeEach(() => {
  H.platform = fakePlatform();
});

describe("edgeImportSites", () => {
  it("400s on invalid JSON", async () => {
    const res = (await edgeImportSites(ctx({ throwJson: true }))) as unknown as Res;
    expect(res.__status).toBe(400);
    expect(res.__data.error).toMatch(/Invalid JSON/);
  });

  it("400s when `sites` is not an array", async () => {
    const res = (await edgeImportSites(ctx({ body: { sites: "nope" } }))) as unknown as Res;
    expect(res.__status).toBe(400);
    expect(res.__data.error).toMatch(/must be an array/);
  });

  it("returns empty result for an empty site list without touching the platform", async () => {
    const res = (await edgeImportSites(ctx({ body: { sites: [] } }))) as unknown as Res;
    expect(res.__data).toEqual({ registered: [], warnings: [] });
    expect(H.platform!.routing.registerRoute).not.toHaveBeenCalled();
  });

  it("400s when the platform has no local edge executor", async () => {
    H.platform = { ...fakePlatform(), executor: null };
    const res = (await edgeImportSites(
      ctx({ body: { sites: [{ serverNames: ["a.com"], ssl: false, target: { kind: "proxy", url: "http://127.0.0.1:3000" } }] } }),
    )) as unknown as Res;
    expect(res.__status).toBe(400);
    expect(res.__data.error).toMatch(/no local edge/i);
  });

  it("registers posted sites into the edge and returns the domains", async () => {
    const res = (await edgeImportSites(
      ctx({
        body: {
          sites: [
            { serverNames: ["a.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" }, tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" } },
          ],
          certPems: { "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } },
        },
      }),
    )) as unknown as Res;

    expect(res.__status).toBe(200);
    expect(res.__data.registered).toEqual(["a.com"]);
    // An imported TLS site's certificate becomes ours to serve, so the route asks
    // for a :443 listener from the start — the cert carried below may not land, and
    // a routed host with no TLS listener refuses the handshake (Cloudflare 525).
    expect(H.platform!.routing.registerRoute).toHaveBeenCalledWith({
      domain: "a.com",
      tls: true,
      terminatesTlsLocally: true,
      targetUrl: "http://127.0.0.1:3000",
    });
    expect(H.platform!.ssl.installCert).toHaveBeenCalledWith("a.com", { certPem: "CERT", keyPem: "KEY" });
  });
});
