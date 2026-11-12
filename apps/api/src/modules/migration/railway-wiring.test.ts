import { describe, expect, it } from "vitest";
import { resolveRailwayBindings } from "@repo/platform/engine/modules/migration/providers/railway-wiring";
import { renderConnectionValue } from "@repo/platform/engine/modules/projects/project-connection.util";
import type { PlannedImportService } from "@repo/platform/engine/modules/migration/platform-import-plan";

function service(id: string, env: Record<string, string> = {}, port?: number) {
  return {
    source: {
      id,
      name: id,
      privateDomain: `${id}.railway.internal`,
      env,
      rawEnv: {},
      blockers: [],
      port,
    },
    create: { name: id, internalAlias: `import-${id}` },
    bindings: [],
    environment: {},
    data: "copy",
    transfer: "cold-volume",
  } as unknown as PlannedImportService;
}
describe("provider-independent connection values", () => {
  it("preserves unknown protocols, credentials, paths and options across redeploys", () => {
    const template = "custom://user:secret@${host}:7878/store?mode=strong#partition";
    expect(renderConnectionValue(template, "http://shared-first:7878")).toBe(
      "custom://user:secret@shared-first:7878/store?mode=strong#partition",
    );
    expect(renderConnectionValue(template, "http://shared-second:9000")).toBe(
      "custom://user:secret@shared-second:7878/store?mode=strong#partition",
    );
    expect(renderConnectionValue("${host}", "redis://shared-first:6379")).toBe("shared-first");
  });
  it("does not execute expressions or accept an unavailable endpoint", () => {
    expect(renderConnectionValue("$(touch file)-${host}", "http://shared-first:1")).toBe(
      "$(touch file)-shared-first",
    );
    expect(() => renderConnectionValue("missing placeholder", "http://host")).toThrow();
    expect(() => renderConnectionValue("${host}", "secret-only")).toThrow();
    expect(() => renderConnectionValue("${host}" + "x".repeat(32_768), "http://host")).toThrow();
  });
});
describe("Railway project wiring", () => {
  it("binds any private service without inferring its type from its image or variable names", () => {
    const store = service("store");
    const app = service("app", {
      ARBITRARY_SETTING: "custom://alice:password@store.railway.internal:7878/second-db?option=1",
    });
    const bindings = resolveRailwayBindings(
      app,
      new Map([
        ["store", store],
        ["app", app],
      ]),
    );
    expect(bindings).toEqual([
      {
        sourceId: "store",
        envKey: "ARBITRARY_SETTING",
      },
    ]);
    expect(store.source.port).toBe(7878);
    expect(app.source.env).toEqual({
      ARBITRARY_SETTING: "custom://alice:password@import-store:7878/second-db?option=1",
    });
  });
  it("keeps literal shared secrets and rewrites self-hosts without a recursive connection", () => {
    const store = service("store", { TOKEN: "secret", HOST: "store.railway.internal" }, 7878);
    expect(resolveRailwayBindings(store, new Map([["store", store]]))).toEqual([]);
    expect(store.source.env).toEqual({ TOKEN: "secret", HOST: "import-store" });
  });
  it("refuses a missing dependency and unresolved provider references", () => {
    const app = service("app", {
      MISSING: "other.railway.internal",
      UNRESOLVED: "${{missing.VALUE}}",
    });
    expect(resolveRailwayBindings(app, new Map([["app", app]]))).toEqual([]);
    expect(app.source.blockers.join(" ")).toMatch(/MISSING/);
    expect(app.source.blockers.join(" ")).toMatch(/UNRESOLVED/);
  });
  it("keeps hostname-only and multi-host values on the native project network", () => {
    const db = service("db"),
      redis = service("redis");
    const app = service("app", {
      HOST: "db.railway.internal",
      HOSTS: "db.railway.internal,redis.railway.internal",
    });
    const bindings = resolveRailwayBindings(
      app,
      new Map([
        ["db", db],
        ["redis", redis],
        ["app", app],
      ]),
    );
    expect(app.source.env).toEqual({ HOST: "import-db", HOSTS: "import-db,import-redis" });
    expect(new Set(bindings.map((binding) => binding.sourceId))).toEqual(new Set(["db", "redis"]));
    expect(app.source.blockers).toEqual([]);
  });
});
