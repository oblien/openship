import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `{{publicUrl:…}}` is how a catalog app learns its own origins, and the deploy is
 * the only place that knows them. Two ways it went wrong silently:
 *
 *  1. A service that had a URL for ONE port was skipped entirely, so Convex's
 *     `{{publicUrl:backend:3211}}` had no entry and `CONVEX_SITE_ORIGIN` shipped
 *     as "" the moment a custom domain was chosen for :3210.
 *  2. The host for the port-only URL came from the server row's DISPLAY `sshHost`,
 *     which is `127.0.0.1` on a box with no public address — and inside a
 *     container that is the container itself.
 *
 * Both produced a value, so nothing failed and nothing warned.
 */

const { getInOrganization, resolveEdgeTargetHost, resolveServiceEndpointUrls } = vi.hoisted(() => ({
  getInOrganization: vi.fn(),
  resolveEdgeTargetHost: vi.fn(),
  resolveServiceEndpointUrls: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/db")>()),
  repos: { server: { getInOrganization } },
}));

vi.mock("../../../src/lib/edge-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/edge-target")>()),
  resolveEdgeTargetHost,
}));

// R1 owns how a route becomes a URL (routing base vs CLOUD_DOMAIN). This suite is
// about what the deploy does WITH those URLs, so the boundary is faked.
vi.mock("../../../src/lib/public-endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/public-endpoints")>()),
  resolveServiceEndpointUrls,
}));

import {
  buildServicePublicUrlMap,
  resolveEnvPublicUrls,
  resolvePortOnlyEnvHost,
} from "../../../src/modules/deployments/compose/deploy.service";
import type { Project, Service } from "@repo/db";

const project = { id: "proj1", slug: "convex-app", name: "convex-app" } as Project;

const svc = (over: Partial<Service>): Service =>
  ({ id: "svc", name: "backend", ports: [], exposedPort: null, ...over }) as unknown as Service;

const backend = svc({
  id: "svc-backend",
  name: "backend",
  ports: ["3210:3210", "3211:3211"],
  exposedPort: "3210",
});
const dashboard = svc({
  id: "svc-dashboard",
  name: "dashboard",
  ports: ["6791:6791"],
  exposedPort: "6791",
});

/** Container ports a compose `ports` list publishes. */
const containerPortsOf = (service: Service) =>
  ((service.ports as string[] | null) ?? []).map((spec) => Number(spec.split(":").pop()));

beforeEach(() => {
  vi.clearAllMocks();
  resolveServiceEndpointUrls.mockReturnValue([]);
});

describe("buildServicePublicUrlMap", () => {
  it("fills the OTHER ports of a service that already has a route on one port", () => {
    // Custom api.example.com chosen for Convex's :3210; :3211 stays port-only.
    resolveServiceEndpointUrls.mockImplementation((_p: Project, s: Service) =>
      s.name === "backend" ? [{ port: 3210, url: "https://api.example.com" }] : [],
    );

    const map = buildServicePublicUrlMap(project, [backend, dashboard], "203.0.113.5");

    expect(map.get("backend:3210")).toBe("https://api.example.com");
    expect(map.get("backend:3211")).toBe("http://203.0.113.5:3211");
    expect(map.get("backend")).toBe("https://api.example.com");
    expect(map.get("dashboard")).toBe("http://203.0.113.5:6791");
  });

  it("the property: with a reachable host, EVERY published container port has an entry", () => {
    resolveServiceEndpointUrls.mockImplementation((_p: Project, s: Service) =>
      s.name === "backend" ? [{ port: 3210, url: "https://api.example.com" }] : [],
    );

    const services = [backend, dashboard];
    const map = buildServicePublicUrlMap(project, services, "203.0.113.5");

    for (const service of services) {
      for (const port of containerPortsOf(service)) {
        expect(map.get(`${service.name}:${port}`)).toMatch(/^https?:\/\/[^\s]+$/);
      }
      expect(map.get(service.name)).toBeDefined();
    }
  });

  it("a route always wins the port it owns", () => {
    resolveServiceEndpointUrls.mockReturnValue([
      { port: 3210, url: "https://api.example.com" },
      { port: 3211, url: "https://http.example.com" },
    ]);

    const map = buildServicePublicUrlMap(project, [backend], "203.0.113.5");

    expect(map.get("backend:3210")).toBe("https://api.example.com");
    expect(map.get("backend:3211")).toBe("https://http.example.com");
  });

  it("keys the primary by the HOST port its container port is published on", () => {
    const map = buildServicePublicUrlMap(
      project,
      [svc({ name: "web", ports: ["18080:3000"], exposedPort: "3000" })],
      "203.0.113.5",
    );

    // exposedPort is a CONTAINER port; the reachable URL must carry the host one.
    expect(map.get("web")).toBe("http://203.0.113.5:18080");
    expect(map.get("web:3000")).toBe("http://203.0.113.5:18080");
  });

  it("invents nothing when no host is known and no route exists", () => {
    const map = buildServicePublicUrlMap(project, [backend, dashboard], null);

    expect(map.size).toBe(0);
  });

  it("a routed service still resolves with no host at all", () => {
    resolveServiceEndpointUrls.mockImplementation((_p: Project, s: Service) =>
      s.name === "backend" ? [{ port: 3210, url: "https://api.example.com" }] : [],
    );

    const map = buildServicePublicUrlMap(project, [backend], null);

    expect(map.get("backend")).toBe("https://api.example.com");
    expect(map.get("backend:3211")).toBeUndefined();
  });
});

describe("resolveEnvPublicUrls", () => {
  const lookup = new Map([["backend:3210", "https://api.example.com"]]);
  const urlFor = (name: string, port?: number) =>
    lookup.get(port !== undefined ? `${name}:${port}` : name);

  it("omits a key it cannot resolve instead of shipping it blank, and reports it", () => {
    const { env, unresolved } = resolveEnvPublicUrls(
      {
        CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
        CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
        INSTANCE_NAME: "convex-self-hosted",
      },
      urlFor,
    );

    expect(env.CONVEX_CLOUD_ORIGIN).toBe("https://api.example.com");
    expect(env.INSTANCE_NAME).toBe("convex-self-hosted");
    expect("CONVEX_SITE_ORIGIN" in env).toBe(false);
    expect(unresolved).toEqual([
      { key: "CONVEX_SITE_ORIGIN", tokens: ["{{publicUrl:backend:3211}}"] },
    ]);
  });

  it("the property: no key whose template had an unresolved token survives", () => {
    const input: Record<string, string> = {
      A: "{{publicUrl:backend:3210}}",
      B: "{{publicUrl:ghost}}",
      C: "prefix-{{publicUrl:backend:3210}}-{{ publicUrl:nope:1 }}-suffix",
      D: "{{publicUrl:backend}}/webhook",
      PLAIN: "no tokens here",
    };
    const { env, unresolved } = resolveEnvPublicUrls(input, urlFor);

    const reported = new Set(unresolved.map((u) => u.key));
    for (const key of Object.keys(input)) {
      // Exactly one of "reported" / "present" is true for every key.
      expect(reported.has(key)).toBe(!(key in env));
    }
    // Nothing that survived carries a leftover token or a half-built origin.
    for (const value of Object.values(env)) {
      expect(value).not.toMatch(/\{\{[^{}]*\}\}/);
    }
    expect([...reported].sort()).toEqual(["B", "C", "D"]);
  });

  it("preserves a legitimately empty value (an unresolved token is not the same thing)", () => {
    const { env, unresolved } = resolveEnvPublicUrls({ BLANK: "" }, urlFor);

    expect("BLANK" in env).toBe(true);
    expect(env.BLANK).toBe("");
    expect(unresolved).toEqual([]);
  });

  it("leaves foreign `{{…}}` grammars alone — an n8n expression is a real value", () => {
    const { env, unresolved } = resolveEnvPublicUrls({ EXPR: "={{ $json.id }}" }, urlFor);

    expect(env.EXPR).toBe("={{ $json.id }}");
    expect(unresolved).toEqual([]);
  });
});

describe("resolvePortOnlyEnvHost", () => {
  it("uses the server row's address and never pays for a public-IP probe", async () => {
    getInOrganization.mockResolvedValue({ sshHost: "203.0.113.9" });

    await expect(resolvePortOnlyEnvHost("org1", { serverId: "srv1" })).resolves.toEqual({
      host: "203.0.113.9",
    });
    expect(resolveEdgeTargetHost).not.toHaveBeenCalled();
  });

  it("keeps a private LAN address — a container on the same box reaches it", async () => {
    getInOrganization.mockResolvedValue({ sshHost: "192.168.1.50" });

    await expect(resolvePortOnlyEnvHost("org1", { serverId: "srv1" })).resolves.toEqual({
      host: "192.168.1.50",
    });
  });

  it.each(["127.0.0.1", "127.0.1.1", "localhost", "0.0.0.0", "::1", "  127.0.0.1  "])(
    "refuses the display address %s and asks the edge resolver for the box's real one",
    async (sshHost) => {
      getInOrganization.mockResolvedValue({ sshHost });
      resolveEdgeTargetHost.mockResolvedValue({ host: "203.0.113.5" });

      await expect(resolvePortOnlyEnvHost("org1", { serverId: "srv1" })).resolves.toEqual({
        host: "203.0.113.5",
      });
    },
  );

  it.each(["127.0.0.1", "localhost", "0.0.0.0", "::1"])(
    "reports unresolved rather than handing a container %s",
    async (sshHost) => {
      getInOrganization.mockResolvedValue({ sshHost });
      resolveEdgeTargetHost.mockResolvedValue({ host: null, reason: "no public address" });

      const result = await resolvePortOnlyEnvHost("org1", { serverId: "srv1" });

      expect(result.host).toBeNull();
      expect(result.reason).toBe("no public address");
    },
  );

  it("cloud publishes no host port, so it never consults the edge resolver", async () => {
    getInOrganization.mockResolvedValue({ sshHost: "127.0.0.1" });

    const result = await resolvePortOnlyEnvHost("org1", {
      serverId: "srv1",
      cloudRuntime: true,
    });

    expect(result.host).toBeNull();
    expect(result.reason).toBeTruthy();
    expect(resolveEdgeTargetHost).not.toHaveBeenCalled();
  });

  it("explains the loopback case when the edge resolver has nothing to add", async () => {
    getInOrganization.mockResolvedValue({ sshHost: "127.0.0.1" });
    resolveEdgeTargetHost.mockResolvedValue({ host: null });

    const result = await resolvePortOnlyEnvHost("org1", { serverId: "srv1" });

    expect(result.host).toBeNull();
    expect(result.reason).toContain("127.0.0.1");
  });

  it("a throwing edge resolver reports unresolved instead of failing the deploy", async () => {
    getInOrganization.mockResolvedValue({ sshHost: "127.0.0.1" });
    resolveEdgeTargetHost.mockRejectedValue(new Error("probe exploded"));

    await expect(resolvePortOnlyEnvHost("org1", { serverId: "srv1" })).resolves.toMatchObject({
      host: null,
    });
  });
});

describe("the Convex regression, end to end", () => {
  it("a custom domain on :3210 leaves CONVEX_SITE_ORIGIN a real origin, never \"\"", async () => {
    resolveServiceEndpointUrls.mockImplementation((_p: Project, s: Service) =>
      s.name === "backend" ? [{ port: 3210, url: "https://api.example.com" }] : [],
    );
    getInOrganization.mockResolvedValue({ sshHost: "203.0.113.5" });

    const { host } = await resolvePortOnlyEnvHost("org1", { serverId: "srv1" });
    const map = buildServicePublicUrlMap(project, [backend, dashboard], host);
    const { env, unresolved } = resolveEnvPublicUrls(
      {
        CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
        CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
      },
      (name, port) => map.get(port !== undefined ? `${name}:${port}` : name),
    );

    expect(unresolved).toEqual([]);
    expect(env).toEqual({
      CONVEX_CLOUD_ORIGIN: "https://api.example.com",
      CONVEX_SITE_ORIGIN: "http://203.0.113.5:3211",
    });
  });

  it("a box with only a loopback display address warns instead of self-referencing", async () => {
    getInOrganization.mockResolvedValue({ sshHost: "127.0.0.1" });
    resolveEdgeTargetHost.mockResolvedValue({ host: null, reason: "no public address" });

    const { host } = await resolvePortOnlyEnvHost("org1", { serverId: "srv1" });
    const map = buildServicePublicUrlMap(project, [backend], host);
    const { env, unresolved } = resolveEnvPublicUrls(
      { CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}" },
      (name, port) => map.get(port !== undefined ? `${name}:${port}` : name),
    );

    expect(env).toEqual({});
    expect(unresolved.map((u) => u.key)).toEqual(["CONVEX_CLOUD_ORIGIN"]);
  });
});
