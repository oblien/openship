import { describe, it, expect } from "vitest";
import type { DiscoveredService } from "./docker-reconcile";
import { buildAdoptedServiceRows, type RepoComposeService } from "./migrate.service";

const repoSvc = (over: Partial<RepoComposeService> & { name: string }): RepoComposeService => ({
  ports: [],
  environment: {},
  dependsOn: [],
  volumes: [],
  ...over,
});

/** Minimal DiscoveredService fixture — only the fields buildAdoptedServiceRows reads. */
const svc = (over: Partial<DiscoveredService> & { name: string }): DiscoveredService =>
  ({
    source: "container",
    running: true,
    ports: [],
    env: {},
    volumes: [],
    networks: [],
    dependsOn: [],
    warnings: [],
    ...over,
  }) as DiscoveredService;

describe("buildAdoptedServiceRows — adoption never host-publishes an internal port (#388)", () => {
  it("drops a bare/expose-only container port so an internal DB (e.g. postgres 5432) isn't re-published on a random host port", () => {
    const { rows } = buildAdoptedServiceRows([svc({ name: "postgres", ports: ["5432"] })], new Set(["postgres"]));
    expect(rows[0]?.ports ?? []).toEqual([]);
  });

  it("keeps a genuinely published host mapping", () => {
    const { rows } = buildAdoptedServiceRows([svc({ name: "web", ports: ["8080:80"] })], new Set(["web"]));
    expect(rows[0]?.ports).toContain("8080:80");
  });
});

describe("buildAdoptedServiceRows — repo-service rename (migration mapping)", () => {
  it("names the adopted row after the mapped repo service AND preserves the live volume + image", () => {
    // The exact same-server case: a moved `postgres` container mapped to the
    // repo's compose service `db`. It must adopt AS `db` (so the later reconcile
    // matches it in place, no duplicate) while KEEPING the original data volume.
    const chosen = [
      svc({
        name: "postgres",
        image: "postgres:16-alpine",
        volumes: [
          { type: "volume", source: "openship-openship-postgres", target: "/var/lib/postgresql/data", rw: true },
        ] as DiscoveredService["volumes"],
      }),
    ];
    const { rows, renames } = buildAdoptedServiceRows(
      chosen,
      new Set(["postgres"]),
      undefined,
      { postgres: "db" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("db"); // adopted under the repo service name
    expect(rows[0]!.volumes).toEqual(["openship-openship-postgres:/var/lib/postgresql/data"]); // volume verbatim
    expect(rows[0]!.image).toBe("postgres:16-alpine"); // running image reused, no build
    expect(rows[0]!.build).toBeUndefined();
    expect(renames).toEqual({ postgres: "db" });
  });

  it("remaps dependsOn onto the renamed rows", () => {
    const chosen = [svc({ name: "api", dependsOn: ["postgres"] }), svc({ name: "postgres" })];
    const { rows } = buildAdoptedServiceRows(chosen, new Set(["api", "postgres"]), undefined, {
      postgres: "db",
    });
    const api = rows.find((r) => r.name === "api");
    expect(api?.dependsOn).toEqual(["db"]); // dep points at the RENAMED row, not "postgres"
  });

  it("falls back to the discovered name when unmapped (identity renames)", () => {
    const { rows, renames, handover } = buildAdoptedServiceRows([svc({ name: "web" })], new Set(["web"]), undefined, undefined);
    expect(rows[0]!.name).toBe("web");
    expect(renames).toEqual({ web: "web" });
    expect(handover).toEqual({}); // no repo → legacy image-only, nothing handed over
  });
});

describe("buildAdoptedServiceRows — native rows from the mapped repo compose", () => {
  it("a build: repo service → NATIVE build context (no frozen tag) + hands over the running image once", () => {
    // The exact 404 case: the running image is a stale build tag. Mapped to a
    // repo `build:` service, the row must carry the BUILD context (so Redeploy
    // reclones + rebuilds), NOT the frozen tag — and the running image is reused
    // exactly once via `handover`.
    const chosen = [svc({ name: "openship-api", image: "openship/openship-api:bld_stale" })];
    const repoServices = new Map([["api", repoSvc({ name: "api", build: "./apps/api" })]]);
    const { rows, handover } = buildAdoptedServiceRows(
      chosen,
      new Set(["openship-api"]),
      undefined,
      { "openship-api": "api" },
      repoServices,
    );
    expect(rows[0]!.name).toBe("api");
    expect(rows[0]!.build).toBe("./apps/api"); // native source → Redeploy rebuilds
    expect(rows[0]!.image).toBeUndefined(); // NOT the stale bld_ tag
    expect(handover).toEqual({ api: "openship/openship-api:bld_stale" }); // reuse once
  });

  it("an image: repo service (postgres) → pulls its registry image, no build, no handover", () => {
    const chosen = [svc({ name: "postgres", image: "postgres:16-alpine" })];
    const repoServices = new Map([["postgres", repoSvc({ name: "postgres", image: "postgres:16-alpine" })]]);
    const { rows, handover } = buildAdoptedServiceRows(
      chosen,
      new Set(["postgres"]),
      undefined,
      undefined,
      repoServices,
    );
    expect(rows[0]!.image).toBe("postgres:16-alpine");
    expect(rows[0]!.build).toBeUndefined();
    expect(handover).toEqual({}); // image-only pulls — nothing to hand over
  });

  it("a discovered container with NO repo mapping stays legacy image-only (unchanged)", () => {
    const chosen = [svc({ name: "legacy", image: "some/img:tag" })];
    const repoServices = new Map([["other", repoSvc({ name: "other", build: "./x" })]]);
    const { rows, handover } = buildAdoptedServiceRows(
      chosen,
      new Set(["legacy"]),
      undefined,
      undefined,
      repoServices,
    );
    expect(rows[0]!.image).toBe("some/img:tag");
    expect(rows[0]!.build).toBeUndefined();
    expect(handover).toEqual({});
  });
});
