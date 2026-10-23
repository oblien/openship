import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
  repos: {
  project: { findById: vi.fn(async (id: string) => ({ id, workspaceId: null })) },
  pullRequestPreview: { findByProject: vi.fn(async () => undefined) },
  routeProtection: { readPrivate: vi.fn(async () => null) },
  domain: {listByProject:vi.fn(async()=>[])},
  deployment: { findById: vi.fn(async () => ({
    id: "dep-1", projectId: "proj-1", organizationId: "org-1", meta: { deployTarget: "local" },
  })) },
} }));

import { repos } from "@repo/db";
import { reconcileProjectRoutes } from "@repo/platform/engine/lib/route-apply.service";

/**
 * The LIVE path: editing a project's request limits has to take effect on save, the
 * way a domain or port edit already does. If it only applied at deploy time, raising
 * an upload limit after hitting a 413 would look like it did nothing until the next
 * redeploy — which is the whole reason the setting is on the routing tab.
 *
 * `reconcileProjectRoutes` reads `project.routingConfig.proxy` itself rather than
 * taking it per-caller: three call sites reach it (a domain edit, a routing-config
 * save, a domain delete), and threading it through each is how they end up emitting
 * different vhosts for the same project.
 */
const project = (proxy?: unknown) => {
  const current = {
    id: "proj-1",
    organizationId: "org-1",
    workspaceId: null,
    activeDeploymentId: "dep-1",
    webhookDomain: null,
    routingConfig: proxy ? ({ proxy } as never) : null,
  };
  vi.mocked(repos.project.findById).mockResolvedValue(current as never);
  return current;
};

// Request-limit behavior is independent of host-port ownership. Use a bridge
// upstream so this focused test does not bypass the loopback route guard with
// invented ownership metadata.
const REGISTER = [
  {
    hostname: "app.example.com",
    targetUrl: "http://172.18.0.2:3000",
    isCustomDomain: false,
  },
];

function fakeRouting() {
  const registerRoute = vi.fn(async () => {});
  return { routing: { registerRoute, removeRoute: vi.fn(async () => {}) } as never, registerRoute };
}

describe("reconcileProjectRoutes — project request limits", () => {
  it("reports a failed vhost write while applying healthy siblings (#879)", async () => {
    const { routing, registerRoute } = fakeRouting();
    registerRoute.mockRejectedValueOnce(new Error("edge rejected the route"));
    const onWarning = vi.fn();
    await reconcileProjectRoutes(project(), {
      routing,
      onWarning,
      registers: [...REGISTER, { ...REGISTER[0], hostname: "healthy.example.com" }],
    });
    expect(registerRoute).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "registerRoute app.example.com failed (non-fatal): edge rejected the route",
      ),
    );
    expect(registerRoute).toHaveBeenLastCalledWith(
      expect.objectContaining({ domain: "healthy.example.com" }),
    );
  });

  it("passes the project's proxy settings into the live vhost", async () => {
    const { routing, registerRoute } = fakeRouting();

    await reconcileProjectRoutes(project({ clientMaxBodySize: "50m", proxyReadTimeout: "300s" }), {
      routing,
      registers: REGISTER,
    });

    expect(registerRoute.mock.calls[0][0]).toMatchObject({
      domain: "app.example.com",
      proxy: { clientMaxBodySize: "50m", proxyReadTimeout: "300s" },
    });
  });

  it("omits proxy entirely when the project sets none", async () => {
    const { routing, registerRoute } = fakeRouting();

    await reconcileProjectRoutes(project(), { routing, registers: REGISTER });

    expect(registerRoute.mock.calls[0][0].proxy).toBeUndefined();
  });

  it("drops a malformed stored value instead of emitting it", async () => {
    // The API validates on write, but a value can also arrive from a repo config or
    // an older schema, and it lands in generated nginx config — so the reconcile
    // re-sanitizes rather than trusting the row.
    const { routing, registerRoute } = fakeRouting();

    await reconcileProjectRoutes(project({ clientMaxBodySize: "25m; root /etc" }), {
      routing,
      registers: REGISTER,
    });

    expect(registerRoute.mock.calls[0][0].proxy).toBeUndefined();
  });

  it("keeps a valid field when a sibling field is malformed", async () => {
    const { routing, registerRoute } = fakeRouting();

    await reconcileProjectRoutes(project({ clientMaxBodySize: "50m", proxyReadTimeout: "nope" }), {
      routing,
      registers: REGISTER,
    });

    expect(registerRoute.mock.calls[0][0].proxy).toEqual({ clientMaxBodySize: "50m" });
  });

  it("applies them to a static route too", async () => {
    const { routing, registerRoute } = fakeRouting();

    await reconcileProjectRoutes(project({ clientMaxBodySize: "50m" }), {
      routing,
      registers: [
        {
          hostname: "site.example.com",
          staticRoot: "/opt/openship/static/site",
          isCustomDomain: false,
        },
      ],
    });

    expect(registerRoute.mock.calls[0][0]).toMatchObject({
      staticRoot: "/opt/openship/static/site",
      proxy: { clientMaxBodySize: "50m" },
    });
  });
});

it("serves externally terminated domains over HTTP without an origin HTTPS redirect",async()=>{
 vi.mocked(repos.domain.listByProject).mockResolvedValueOnce([{hostname:"app.example.com",externalIngress:true}] as never);
 const {routing,registerRoute}=fakeRouting();
 await reconcileProjectRoutes(project(),{routing,registers:[{...REGISTER[0],isCustomDomain:true}]});
 expect(registerRoute).toHaveBeenCalledWith(expect.objectContaining({domain:"app.example.com",tls:false,terminatesTlsLocally:false}));
});

it("checks stored ingress mode before removing any live route",async()=>{
  vi.mocked(repos.domain.listByProject).mockRejectedValueOnce(new Error("domain inventory unavailable"));
  const removeRoute=vi.fn(),registerRoute=vi.fn();
  await expect(reconcileProjectRoutes(project(),{
    routing:{removeRoute,registerRoute} as never,
    registers:REGISTER,
    removes:[{hostname:"old.example.com"}],
  })).rejects.toThrow("domain inventory unavailable");
  expect(removeRoute).not.toHaveBeenCalled();
  expect(registerRoute).not.toHaveBeenCalled();
});
