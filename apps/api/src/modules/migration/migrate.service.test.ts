import { describe, it, expect, vi } from "vitest";
import type { DiscoveredService } from "./docker-reconcile";

const getFileContent = vi.hoisted(() => vi.fn());

vi.mock("../github/github.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileContent,
}));

import {
  buildAdoptedServiceRows,
  parseRepoCompose,
  type RepoComposeService,
} from "./migrate.service";

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

describe("parseRepoCompose — build args (#689)", () => {
  it("keeps distinct args for services that share a Dockerfile", async () => {
    getFileContent.mockReset();
    getFileContent.mockResolvedValueOnce({
      content: `
services:
  api:
    build:
      context: ../../
      dockerfile: services/shared/Dockerfile
      args:
        APP_PACKAGE: "@myorg/api"
        FROM_ENV:
        CHANNEL: "\${RELEASE_CHANNEL:-stable}"
  worker:
    build:
      context: ../../
      dockerfile: services/shared/Dockerfile
      args:
        APP_PACKAGE: "@myorg/worker"
`,
    });

    const services = await parseRepoCompose(
      {} as Parameters<typeof parseRepoCompose>[0],
      "myorg",
      "monorepo",
      "main",
    );

    expect(
      services.map(({ name, build, dockerfile, buildArgs, advanced }) => ({
        name,
        build,
        dockerfile,
        buildArgs,
        advanced,
      })),
    ).toEqual([
      {
        name: "api",
        build: "../../",
        dockerfile: "services/shared/Dockerfile",
        buildArgs: {
          APP_PACKAGE: "@myorg/api",
          FROM_ENV: null,
          CHANNEL: "${RELEASE_CHANNEL:-stable}",
        },
        advanced: { buildArgTemplateKeys: ["CHANNEL"] },
      },
      {
        name: "worker",
        build: "../../",
        dockerfile: "services/shared/Dockerfile",
        buildArgs: { APP_PACKAGE: "@myorg/worker" },
        advanced: { buildArgTemplateKeys: [] },
      },
    ]);
  });
});

describe("buildAdoptedServiceRows — adoption never host-publishes an adopted port (#388)", () => {
  it("drops a bare/expose-only container port so an internal DB (e.g. postgres 5432) isn't re-published on a random host port", () => {
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "postgres", ports: ["5432"] })],
      new Set(["postgres"]),
    );
    expect(rows[0]?.ports ?? []).toEqual([]);
  });

  it("records an expose-only port as exposedPort, so the service is still routable", () => {
    // Stripping leaves `ports: []` (a bare spec is a publish instruction — keeping it
    // would bind a random loopback port). `exposedPort` records what the container
    // LISTENS on without publishing anything, which is what both the Domains tab's
    // findServiceByPort and the project-level route resolver match on (#618).
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "postgres", ports: ["5432"] })],
      new Set(["postgres"]),
    );
    expect(rows[0]?.ports ?? []).toEqual([]);
    expect(rows[0]?.exposedPort).toBe("5432");
  });

  it("records the first port for a multi-EXPOSE image and publishes none of them", () => {
    // mysql EXPOSEs 3306 + 33060, neither published. Keeping both in `ports` would
    // publish two random loopback ports; recording one exposedPort publishes nothing.
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "mysql", ports: ["3306", "33060"] })],
      new Set(["mysql"]),
    );
    expect(rows[0]?.ports ?? []).toEqual([]);
    expect(rows[0]?.exposedPort).toBe("3306");
  });

  it("leaves exposedPort unset when `ports` already records the container port", () => {
    // A pinned publish keeps its container side, so there is nothing missing to record —
    // and writing exposedPort here would overwrite an operator's own value on a re-import.
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "web", ports: ["8080:3000"] })],
      new Set(["web"]),
    );
    expect(rows[0]?.ports).toEqual(["3000"]);
    expect(rows[0]?.exposedPort).toBeUndefined();
  });

  it("strips a pinned host mapping to the container port only — the #388 collision fix", () => {
    // A discovered "5432:5432" (e.g. carried over from a Coolify migration) would
    // bind host 5432 at deploy and collide with whatever already holds it —
    // Openship's OWN Postgres, or a second project's — aborting the whole deploy.
    // Adoption keeps only the container side; the service is reached by name and
    // re-exposed later from the Domains tab.
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "postgres", ports: ["5432:5432"] })],
      new Set(["postgres"]),
    );
    expect(rows[0]?.ports).toEqual(["5432"]);
  });

  it("keeps the container port for an edge-owned 80/443 publish (OpenResty routes to it)", () => {
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "web", ports: ["80:3000"] })],
      new Set(["web"]),
    );
    expect(rows[0]?.ports).toEqual(["3000"]);
  });

  it("strips any other pinned publish and preserves the protocol suffix", () => {
    const { rows } = buildAdoptedServiceRows(
      [svc({ name: "app", ports: ["8080:80", "5353:53/udp"] })],
      new Set(["app"]),
    );
    expect(rows[0]?.ports).toEqual(["80", "53/udp"]);
  });

  it("warns the operator once per service, naming the stripped host ports and the route path", () => {
    const service = svc({ name: "web", ports: ["8080:80"] });
    buildAdoptedServiceRows([service], new Set(["web"]));
    expect(service.warnings.some((w) => w.includes("8080") && w.includes("Domains tab"))).toBe(
      true,
    );
  });

  it("flags an off-box publish as external exposure that was dropped (the security-meaningful signal)", () => {
    // Bare "5432:5432" binds all interfaces — Postgres was reachable from the
    // internet (Docker's publish DNATs past the host firewall). The warning must
    // say the EXTERNAL exposure was removed, not just cite a port number.
    const service = svc({ name: "postgres", ports: ["5432:5432"] });
    buildAdoptedServiceRows([service], new Set(["postgres"]));
    const w = service.warnings.find((x) => x.includes("5432"))!;
    expect(w).toContain("externally");
    expect(w).not.toContain("Loopback-only");
  });

  it("still strips a loopback-only publish but does NOT claim external exposure was lost", () => {
    // 127.0.0.1:5432:5432 never left the box, so the strip costs no external
    // reachability — the note stays factual instead of over-warning.
    const service = svc({ name: "postgres", ports: ["127.0.0.1:5432:5432"] });
    const { rows } = buildAdoptedServiceRows([service], new Set(["postgres"]));
    expect(rows[0]?.ports).toEqual(["5432"]); // still stripped to the container port
    const w = service.warnings.find((x) => x.includes("5432"))!;
    expect(w).toContain("Loopback-only");
    expect(w).not.toContain("externally");
    expect(w).toContain("Domains tab");
  });

  it("separates external and loopback publishes in one warning when both are present", () => {
    const service = svc({ name: "app", ports: ["0.0.0.0:7000:7000", "127.0.0.1:6000:6000"] });
    buildAdoptedServiceRows([service], new Set(["app"]));
    const w = service.warnings.find((x) => x.includes("7000"))!;
    expect(w).toContain("7000"); // external clause
    expect(w).toContain("externally");
    expect(w).toContain("6000"); // loopback clause
    expect(w).toContain("Loopback-only");
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
          {
            type: "volume",
            source: "openship-openship-postgres",
            target: "/var/lib/postgresql/data",
            rw: true,
          },
        ] as DiscoveredService["volumes"],
      }),
    ];
    const { rows, renames } = buildAdoptedServiceRows(chosen, new Set(["postgres"]), undefined, {
      postgres: "db",
    });
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
    const { rows, renames, handover } = buildAdoptedServiceRows(
      [svc({ name: "web" })],
      new Set(["web"]),
      undefined,
      undefined,
    );
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
    const repoServices = new Map([
      [
        "api",
        repoSvc({
          name: "api",
          build: "./apps/api",
          buildArgs: { APP_PACKAGE: "@myorg/api", FROM_ENV: null },
        }),
      ],
    ]);
    const { rows, handover } = buildAdoptedServiceRows(
      chosen,
      new Set(["openship-api"]),
      undefined,
      { "openship-api": "api" },
      repoServices,
    );
    expect(rows[0]!.name).toBe("api");
    expect(rows[0]!.build).toBe("./apps/api"); // native source → Redeploy rebuilds
    expect(rows[0]!.buildArgs).toEqual({ APP_PACKAGE: "@myorg/api", FROM_ENV: null });
    expect(rows[0]!.image).toBeUndefined(); // NOT the stale bld_ tag
    expect(handover).toEqual({ api: "openship/openship-api:bld_stale" }); // reuse once
  });

  it("an image: repo service (postgres) → pulls its registry image, no build, no handover", () => {
    const chosen = [svc({ name: "postgres", image: "postgres:16-alpine" })];
    const repoServices = new Map([
      ["postgres", repoSvc({ name: "postgres", image: "postgres:16-alpine" })],
    ]);
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

describe("buildAdoptedServiceRows — two same-named picks stay distinct (#584 class)", () => {
  // Selecting `postgres` from two different stacks into one project. The rows are
  // de-duplicated by suffixing, but every per-service INPUT used to be keyed by name,
  // so both rows read the first one's entry — and `renames` itself collapsed, which is
  // what row resolution, the attach/join container match and the route remap all key on.
  const OURS = svc({ name: "postgres", containerId: "c-a", image: "postgres:16" });
  const THEIRS = svc({ name: "postgres", containerId: "c-b", image: "postgres:18" });

  it("maps each container to its OWN row name", () => {
    const { rows, renames } = buildAdoptedServiceRows([OURS, THEIRS]);
    expect(rows.map((r) => r.name)).toEqual(["postgres", "postgres-2"]);
    expect(renames["c-a"]).toBe("postgres");
    expect(renames["c-b"]).toBe("postgres-2");
  });

  it("applies each service's env override to its own row", () => {
    const { rows } = buildAdoptedServiceRows([OURS, THEIRS], undefined, {
      "c-a": { WHICH: "ours" },
      "c-b": { WHICH: "theirs" },
    });
    expect(rows[0]!.environment).toMatchObject({ WHICH: "ours" });
    expect(rows[1]!.environment).toMatchObject({ WHICH: "theirs" });
  });

  it("renames only the service the operator mapped", () => {
    const { rows, renames } = buildAdoptedServiceRows([OURS, THEIRS], undefined, undefined, {
      "c-b": "db",
    });
    expect(rows.map((r) => r.name)).toEqual(["postgres", "db"]);
    expect(renames["c-b"]).toBe("db");
  });

  it("still keys by name for a client that sends name keys", () => {
    // One pick, no ambiguity — the legacy shape must keep working unchanged.
    const { rows, renames } = buildAdoptedServiceRows([THEIRS], undefined, {
      postgres: { WHICH: "legacy" },
    });
    expect(rows[0]!.environment).toMatchObject({ WHICH: "legacy" });
    expect(renames["c-b"]).toBe("postgres");
  });
});

/**
 * `renames` is keyed by service IDENTITY so two same-named picks can't overwrite each
 * other. That makes it unusable for a caller holding only a NAME — and the orchestrator's
 * `remapKeys` was exactly that caller: every lookup missed, the key passed through
 * unrenamed, and `publishRoutes` then looked the row up by the DISCOVERED name and
 * silently dropped a renamed service's route. `rowNameByDiscovered` is the name-keyed
 * accessor those callers need.
 */
describe("buildAdoptedServiceRows — rename maps are keyed for their callers", () => {
  it("exposes a NAME-keyed map alongside the identity-keyed one", () => {
    const { renames, rowNameByDiscovered } = buildAdoptedServiceRows(
      [svc({ name: "web", containerId: "abc123" })],
      new Set(["web"]),
      undefined,
      { web: "frontend" },
    );
    // Identity-keyed: a bare-name lookup misses, which is the trap.
    expect(renames["web"]).toBeUndefined();
    // Name-keyed: what a caller with only "web" needs.
    expect(rowNameByDiscovered["web"]).toBe("frontend");
  });

  it("maps an unrenamed service to its own name", () => {
    const { rowNameByDiscovered } = buildAdoptedServiceRows(
      [svc({ name: "postgres", containerId: "def456" })],
      new Set(["postgres"]),
    );
    expect(rowNameByDiscovered["postgres"]).toBe("postgres");
  });

  it("keeps the FIRST of two same-named picks, matching the row de-duplication", () => {
    // The second becomes `web-2`; a name-keyed map can only hold one, and it must be the
    // one `dependsOn` remapping already resolves to.
    const { rowNameByDiscovered, rows } = buildAdoptedServiceRows(
      [svc({ name: "web", containerId: "a" }), svc({ name: "web", containerId: "b" })],
      new Set(["web"]),
    );
    expect(rows.map((r) => r.name)).toEqual(["web", "web-2"]);
    expect(rowNameByDiscovered["web"]).toBe("web");
  });
});
