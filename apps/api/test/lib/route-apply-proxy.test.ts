import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({ repos: {} }));

import { reconcileProjectRoutes } from "../../src/lib/route-apply.service";

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
const project = (proxy?: unknown) => ({
  id: "proj-1",
  organizationId: "org-1",
  cloudWorkspaceId: null,
  activeDeploymentId: "dep-1",
  webhookDomain: null,
  routingConfig: proxy ? ({ proxy } as never) : null,
});

const REGISTER = [{ hostname: "app.example.com", targetUrl: "http://127.0.0.1:3000", isCustomDomain: false }];

function fakeRouting() {
  const registerRoute = vi.fn(async () => {});
  return { routing: { registerRoute, removeRoute: vi.fn(async () => {}) } as never, registerRoute };
}

describe("reconcileProjectRoutes — project request limits", () => {
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
      registers: [{ hostname: "site.example.com", staticRoot: "/opt/openship/static/site", isCustomDomain: false }],
    });

    expect(registerRoute.mock.calls[0][0]).toMatchObject({
      staticRoot: "/opt/openship/static/site",
      proxy: { clientMaxBodySize: "50m" },
    });
  });
});
