import { describe, expect, it } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../src/lib/route-permission";

/**
 * #336: compose-service `environment` is masked on every READ surface, and the
 * REAL values are exposed only through explicit reveal endpoints. The security
 * property this test locks in: reveal is strictly higher-privilege than viewing
 * the masked map — a read-only caller can see `••••••••` but can never fetch the
 * plaintext. If someone re-tags a reveal route down to `:read`, this fails.
 */
describe("#336 env reveal is write-gated; masked reads need only read", () => {
  it("reveal routes require write; the masked GETs require only read", async () => {
    await Promise.all([
      import("../../src/modules/services/service.routes"),
      import("../../src/modules/projects/project.routes"),
      import("../../src/modules/deployments/deployment.routes"),
      import("../../src/modules/migration/migration.routes"),
    ]);

    const reg = getRouteRegistry();
    const tagOf = (pred: (r: (typeof reg)[number]) => boolean, label: string): string => {
      const route = reg.find(pred);
      expect(route, `route not registered: ${label}`).toBeDefined();
      const spec = route!.spec;
      return isPublicSpec(spec) ? "PUBLIC" : spec.tag;
    };

    // Reveal endpoints — write-gated.
    expect(
      tagOf(
        (r) => r.method === "GET" && r.path.endsWith("/env-reveal") && r.path.includes("/services/"),
        "service env-reveal",
      ),
    ).toBe("project:service:write");

    expect(
      tagOf(
        (r) => r.method === "GET" && r.path.endsWith("/env-reveal") && r.path.includes("/folder/scan/"),
        "folder-scan env-reveal",
      ),
    ).toBe("project:write");

    // Migration container reveal — write-gated, same bar as the service reveal.
    expect(
      tagOf(
        (r) => r.method === "POST" && r.path.endsWith("/migration/reveal-env"),
        "migration reveal-env",
      ),
    ).toBe("server:write");

    // Masked reads — only `:read` (proving reveal is the higher bar).
    expect(
      tagOf((r) => r.method === "GET" && r.path.endsWith("/services/:serviceId"), "service GET"),
    ).toBe("project:service:read");

    expect(
      tagOf((r) => r.method === "GET" && r.path === "/api/deployments/:id", "deployment GET"),
    ).toBe("deployment:read");
  });
});
