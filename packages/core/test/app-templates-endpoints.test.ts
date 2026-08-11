import { describe, it, expect } from "vitest";
import {
  APP_TEMPLATES,
  declaredServiceRoutes,
  defaultAppRouteLabel,
  getAppEndpoints,
  getAppTemplate,
  resolveServiceHostnameLabel,
  type AppTemplate,
} from "../src/index";

/**
 * The install wizard asks about ONE endpoint per DECLARED ROUTE, not per service.
 *
 * A service's secondary route (Convex's 3211 HTTP-actions port) used to be
 * invisible: `getAppEndpoints` surfaced a single endpoint per service, so the
 * wizard never rendered a picker for 3211 — yet the installer derived a live
 * *.opsh.io hostname for it from the primary's slug, with cloud registration, a
 * vhost and a cert. A hostname nobody was shown and nobody chose.
 */

/** Every (service, port) a template declares as routable, as a sorted key list. */
function declaredRouteKeys(template: AppTemplate): string[] {
  const keys: string[] = [];
  for (const svc of template.services ?? []) {
    if (!svc.exposed) continue;
    for (const route of declaredServiceRoutes(svc)) keys.push(`${svc.name}:${route.port}`);
  }
  return keys.sort();
}

describe("getAppEndpoints — one picker per declared route", () => {
  it("surfaces EVERY declared route of EVERY exposed service, for every catalog app", () => {
    // The property, over the whole catalog: no declared route may be missing from
    // what the wizard shows, and none may be duplicated. Asserting the property
    // (not one app's port list) is what makes a newly-added multi-port app fail
    // here instead of silently minting a hostname.
    const multiPort: string[] = [];
    for (const template of APP_TEMPLATES) {
      if (template.endpoints?.length) continue; // explicit endpoints are the author's own list
      const shown = getAppEndpoints(template)
        .map((e) => `${e.service}:${e.port}`)
        .sort();
      expect(shown, `app "${template.id}"`).toEqual(declaredRouteKeys(template));
      expect(new Set(shown).size, `app "${template.id}" has duplicate endpoints`).toBe(shown.length);
      if (
        (template.services ?? []).some((s) => s.exposed && declaredServiceRoutes(s).length > 1)
      ) {
        multiPort.push(template.id);
      }
    }
    // Guard the guard: if no bundled app declares a multi-port service, the loop
    // above proves nothing about the bug it exists for.
    expect(multiPort.length).toBeGreaterThan(0);
  });

  it("shows Convex's HTTP-actions port as its own endpoint", () => {
    const convex = getAppTemplate("convex")!;
    expect(getAppEndpoints(convex).map((e) => `${e.service}:${e.port}`)).toEqual([
      "backend:3210",
      "backend:3211",
      "dashboard:6791",
    ]);
    // Distinct labels — two rows reading "backend" would be unpickable.
    const labels = getAppEndpoints(convex)
      .filter((e) => e.service === "backend")
      .map((e) => e.label);
    expect(new Set(labels).size).toBe(2);
  });

  it("keeps an explicit `endpoints` list authoritative", () => {
    const template = {
      id: "x",
      name: "X",
      description: "",
      kind: "template",
      logo: "x",
      category: "other",
      endpoints: [{ service: "web", port: 80, label: "Web", kind: "http" }],
      services: [{ name: "web", image: "nginx", exposed: true, routes: [{ port: 80 }, { port: 8443, slugSuffix: "tls" }] }],
    } as unknown as AppTemplate;
    expect(getAppEndpoints(template)).toEqual(template.endpoints);
  });

  it("does not offer a route for a service the template doesn't expose", () => {
    const template = {
      services: [{ name: "db", image: "pg", exposed: false, exposedPort: 5432 }],
    } as unknown as AppTemplate;
    expect(getAppEndpoints(template)).toEqual([]);
  });
});

describe("declaredServiceRoutes", () => {
  it("lists declared routes primary-first and keeps exposedPort askable", () => {
    expect(declaredServiceRoutes({ routes: [{ port: 9001 }, { port: 9000, slugSuffix: "s3" }], exposedPort: 9001 })).toEqual([
      { port: 9001, slugSuffix: undefined },
      { port: 9000, slugSuffix: "s3" },
    ]);
    // exposedPort NOT among the declared routes still gets an entry — otherwise
    // the service's primary port would be unaskable in the wizard.
    expect(declaredServiceRoutes({ routes: [{ port: 9000 }], exposedPort: 8080 })).toEqual([
      { port: 9000, slugSuffix: undefined },
      { port: 8080 },
    ]);
    expect(declaredServiceRoutes({ exposedPort: 3000 })).toEqual([{ port: 3000 }]);
    expect(declaredServiceRoutes({})).toEqual([]);
    // A port declared twice yields one entry — one picker, one route.
    expect(declaredServiceRoutes({ routes: [{ port: 80 }, { port: 80, slugSuffix: "dup" }] })).toEqual([
      { port: 80, slugSuffix: undefined },
    ]);
  });
});

describe("defaultAppRouteLabel", () => {
  it("is the service label, suffixed per declared route", () => {
    expect(defaultAppRouteLabel("convex", "backend")).toBe("convex-backend");
    expect(defaultAppRouteLabel("convex", "backend", "http")).toBe("convex-backend-http");
  });

  it("agrees with resolveServiceHostnameLabel for a suffix-less route", () => {
    // The wizard previews this and the installer persists it; if these two ever
    // diverge the operator is shown a hostname they don't get.
    for (const [project, service] of [
      ["convex", "backend"],
      ["my-store", "web"],
      ["My Store", "dashboard"],
    ] as const) {
      expect(defaultAppRouteLabel(project, service)).toBe(
        resolveServiceHostnameLabel(project, service, undefined, "compose"),
      );
    }
  });
});
