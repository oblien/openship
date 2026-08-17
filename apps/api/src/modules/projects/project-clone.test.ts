import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Duplicating a project copies its RECORDS. These tests exist for three things that are invisible
 * to a typecheck and destructive-ish when wrong:
 *
 *   1. the copy direction is spread-minus-exclusions, so a column added later is copied by
 *      DEFAULT (the anti-drift test). The old adopt-based duplicate silently lost fields;
 *      an allowlist here would reintroduce exactly that, one migration at a time.
 *   2. `volumes` / `namespaceVolumes` come from the RUNTIME, not the rows. The transfer streams
 *      each volume under the same name it had on the source, so a copy that re-namespaced them
 *      to its own slug would mount volumes nothing ever wrote — an empty database, reported as
 *      a successful duplicate.
 *   3. `created: true`, because the orchestrator's rollback deletes the project the run created.
 */

const h = {
  project: {
    id: "p_src",
    organizationId: "org1",
    groupId: "app_src",
    name: "clincai",
    slug: "clincai",
    serverId: "srv_a",
    environmentSlug: "production",
    activeDeploymentId: "dep_live",
    framework: "nextjs",
    routeStrategy: "loopback",
    rollbackWindow: 5,
    disabledAt: new Date(),
    deletedAt: null,
    deletionInProgress: false,
    favicon: "https://clincai.example/favicon.ico",
    faviconCheckedAt: new Date(),
    compositeRoutes: [{ host: "clincai.example" }],
    gitProvider: "github",
    gitOwner: "acme",
    gitRepo: "clincai",
    gitUrl: "https://github.com/acme/clincai.git",
    createdAt: new Date("2020-01-01"),
    updatedAt: new Date("2020-01-01"),
  } as Record<string, unknown>,
  services: [
    {
      id: "svc_web",
      projectId: "p_src",
      name: "web",
      kind: "compose",
      image: "openship/web:abc",
      // The LOGICAL declaration. The running container mounts a namespaced name (below).
      volumes: ["assets:/app/public"],
      namespaceVolumes: true,
      exposed: true,
      exposedPort: "3000",
      domain: "clincai",
      customDomain: "clincai.example",
      domainType: "custom",
      publicEndpoints: [{ port: 3000, domainType: "custom", customDomain: "clincai.example" }],
      buildCommand: "next build",
      sortOrder: 1,
      createdAt: new Date("2020-01-01"),
      updatedAt: new Date("2020-01-01"),
    },
    {
      id: "svc_db",
      projectId: "p_src",
      name: "db",
      kind: "compose",
      image: "postgres:16",
      volumes: ["pgdata:/var/lib/postgresql/data"],
      namespaceVolumes: true,
      exposed: false,
      sortOrder: 2,
      createdAt: new Date("2020-01-01"),
      updatedAt: new Date("2020-01-01"),
    },
  ] as Array<Record<string, unknown>>,
  env: [
    { id: "e1", projectId: "p_src", serviceId: null, key: "SHARED", value: "v", environment: "production", isSecret: false },
    { id: "e2", projectId: "p_src", serviceId: "svc_db", key: "POSTGRES_PASSWORD", value: "enc:hunter2", environment: "production", isSecret: true },
    // Scoped to a service that is NOT part of a narrowed copy.
    { id: "e3", projectId: "p_src", serviceId: "svc_web", key: "WEB_ONLY", value: "w", environment: "production", isSecret: false },
  ] as Array<Record<string, unknown>>,
  slugsTaken: new Set<string>(),
  created: null as null | Record<string, unknown>,
};

// `vi.hoisted` because `vi.mock` below is lifted to the top of the file — a plain `const` spy
// referenced inside the factory is not initialised yet when the factory runs.
const { createProjectWithRecords } = vi.hoisted(() => ({
  createProjectWithRecords: vi.fn(),
}));

// Partial mock: the clone reuses `assertProjectQuota`/`uniqueProjectSlug` from the project CRUD
// service, whose import graph reaches auth → `schema`. Replacing the whole module would strip
// exports this file never touches but that graph needs, so only `repos` is swapped.
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repos: {
    project: {
      findByIdInOrganization: async (id: string, org: string) =>
        id === h.project.id && org === h.project.organizationId ? { ...h.project } : null,
      findBySlugInOrg: async (_org: string, slug: string) => (h.slugsTaken.has(slug) ? { id: "x" } : null),
      listEnvVars: async () => h.env.map((v) => ({ ...v })),
      createProjectWithRecords,
    },
    service: { listByProject: async () => h.services.map((s) => ({ ...s })) },
    projectGroup: { listByOrganization: async () => ({ total: 0 }) },
  },
}));

import { cloneProjectToServer, CLONE_EXCLUSIONS } from "./project-clone.service";
import type { DiscoveredService } from "../migration/docker-reconcile";

/** A running container as discovery reports it — note the RESOLVED, namespaced volume source. */
const discovered = (name: string, volumeSource: string, target: string): DiscoveredService =>
  ({
    name,
    source: "container",
    containerId: `c_${name}`,
    running: true,
    image: `img/${name}:live`,
    ports: [],
    env: {},
    volumes: [{ source: volumeSource, target, rw: true }],
    networks: [],
    dependsOn: [],
  }) as unknown as DiscoveredService;

const CHOSEN = [
  discovered("web", "openship-clincai-assets", "/app/public"),
  discovered("db", "openship-clincai-pgdata", "/var/lib/postgresql/data"),
];

const clone = (over: Partial<Parameters<typeof cloneProjectToServer>[0]> = {}) =>
  cloneProjectToServer({
    sourceProjectId: "p_src",
    organizationId: "org1",
    targetServerId: "srv_b",
    chosen: CHOSEN,
    ...over,
  });

const clonedProject = () => h.created!.project as Record<string, unknown>;
const clonedServices = () =>
  (h.created!.services as Array<{ sourceId: string; row: Record<string, unknown> }>);
const clonedEnv = () => h.created!.envVars as Array<Record<string, unknown>>;

beforeEach(() => {
  h.created = null;
  h.slugsTaken = new Set();
  createProjectWithRecords.mockReset();
  // Stands in for the transactional repo write: records what it was asked to create and mints
  // the ids the real one would.
  createProjectWithRecords.mockImplementation(async (input: Record<string, unknown>) => {
    h.created = input;
    return {
      project: { id: "p_new", groupId: "app_new", ...(input.project as Record<string, unknown>) },
      serviceIdBySourceId: Object.fromEntries(
        (input.services as Array<{ sourceId: string }>).map((s, i) => [s.sourceId, `svc_new_${i}`]),
      ),
    };
  });
});

describe("the copy direction is COPY-by-default", () => {
  it("carries a field nobody told it about", async () => {
    // THE anti-drift test. Add a column to the project table and it lands on the clone with no
    // code change here; switch this module to an allowlist and this fails. A duplicate that
    // quietly drops the newest setting is the exact failure the adopt-based version had.
    h.project.someFutureSetting = "keep-me";
    await clone();
    expect(clonedProject().someFutureSetting).toBe("keep-me");
    delete h.project.someFutureSetting;
  });

  it("carries the settings Docker inspection could never have recovered", async () => {
    await clone();
    const p = clonedProject();
    expect(p.framework).toBe("nextjs");
    expect(p.routeStrategy).toBe("loopback");
    expect(p.rollbackWindow).toBe(5);
    // Same for the service rows: a build command exists in no container.
    expect(clonedServices()[0]!.row.buildCommand).toBe("next build");
    expect(clonedServices()[0]!.row.kind).toBe("compose");
  });

  it("carries a service field nobody told it about either", async () => {
    h.services[0]!.someFutureServiceField = "svc-keep";
    await clone();
    expect(clonedServices()[0]!.row.someFutureServiceField).toBe("svc-keep");
    delete h.services[0]!.someFutureServiceField;
  });
});

describe("what it deliberately does NOT copy", () => {
  it("points at the target server and starts with no deployment", async () => {
    await clone();
    expect(clonedProject().serverId).toBe("srv_b");
    expect(clonedProject().activeDeploymentId).toBeNull();
  });

  it("omits every excluded project field, so the insert cannot inherit one", async () => {
    await clone();
    const p = clonedProject();
    // `id`/`groupId` are the insert's, and name/slug/serverId/activeDeploymentId are set
    // explicitly above — the rest must simply be absent.
    for (const field of ["deletedAt", "deletionInProgress", "disabledAt", "favicon", "faviconCheckedAt", "compositeRoutes", "id", "groupId", "createdAt", "updatedAt"]) {
      expect(p, field).not.toHaveProperty(field);
    }
  });

  it("starts with NO domains — the originals stay with the project serving them", async () => {
    await clone();
    const web = clonedServices()[0]!.row;
    for (const field of ["exposed", "exposedPort", "domain", "customDomain", "domainType", "publicEndpoints"]) {
      expect(web, field).not.toHaveProperty(field);
    }
  });

  it("never reuses the source's group, which the DB would refuse anyway", async () => {
    // `uq_project_app_environment_slug_active` is unique on (groupId, environmentSlug) and both
    // projects are `production`, so sharing a group is a constraint violation. Its own group
    // also means "a separate app", which is what a duplicate on another host is.
    await clone();
    expect(clonedProject()).not.toHaveProperty("groupId");
    expect((h.created!.group as Record<string, unknown>).slug).toBe("clincai-copy");
  });
});

describe("volumes come from the RUNTIME, not the rows", () => {
  it("mounts the resolved names the transfer actually wrote", async () => {
    await clone();
    const rows = clonedServices();
    // NOT "pgdata:/var/lib/postgresql/data" (the row's logical declaration) — the bytes landed
    // on the target under the source's resolved volume name.
    expect(rows[1]!.row.volumes).toEqual([
      "openship-clincai-pgdata:/var/lib/postgresql/data",
    ]);
    expect(rows[0]!.row.volumes).toEqual(["openship-clincai-assets:/app/public"]);
  });

  it("turns namespacing OFF, so the new slug cannot rewrite those names", async () => {
    // With namespacing on, the copy's deploy would mount openship-<newslug>-pgdata — a volume
    // the transfer never created. The copy would start empty and report success.
    await clone();
    for (const svc of clonedServices()) expect(svc.row.namespaceVolumes).toBe(false);
  });

  it("drops an anonymous mount rather than inventing a name for it", async () => {
    const anon = { ...discovered("db", "", "/tmp/cache") };
    await clone({ chosen: [CHOSEN[0]!, anon as DiscoveredService] });
    expect(clonedServices()[1]!.row.volumes).toEqual([]);
  });
});

describe("env vars", () => {
  it("copies them verbatim, ciphertext included", async () => {
    // The copy is handed a byte copy of the source's volume, so a re-generated password would
    // lock it out of its own database. Identical value is the requirement, not an oversight.
    await clone();
    const pw = clonedEnv().find((v) => v.key === "POSTGRES_PASSWORD");
    expect(pw?.value).toBe("enc:hunter2");
    expect(pw?.isSecret).toBe(true);
    expect(pw?.sourceServiceId).toBe("svc_db");
  });

  it("keeps project-scoped vars project-scoped", async () => {
    await clone();
    expect(clonedEnv().find((v) => v.key === "SHARED")?.sourceServiceId).toBeNull();
  });

  it("drops vars belonging to a service the copy doesn't include", async () => {
    // A narrowed (service-level) duplicate. `WEB_ONLY` follows a service that isn't coming, and
    // promoting it to project scope would hand one service's config to every other.
    await clone({ chosen: [CHOSEN[1]!] });
    expect(clonedEnv().map((v) => v.key)).toEqual(["SHARED", "POSTGRES_PASSWORD"]);
  });
});

describe("naming", () => {
  it("derives <name> copy and slugifies it", async () => {
    await clone();
    expect(clonedProject().name).toBe("clincai copy");
    expect(clonedProject().slug).toBe("clincai-copy");
  });

  it("suffixes past a taken slug", async () => {
    h.slugsTaken.add("clincai-copy");
    await clone();
    expect(clonedProject().slug).toBe("clincai-copy-2");
  });

  it("takes the operator's name when given", async () => {
    await clone({ name: "Clincai Staging" });
    expect(clonedProject().name).toBe("Clincai Staging");
    expect(clonedProject().slug).toBe("clincai-staging");
  });
});

describe("the AdoptResult it hands back", () => {
  it("reports created: true, so a failed run's rollback deletes the copy", async () => {
    // The inverse of a MOVE, where `created` must be false or rollback would delete the
    // operator's real project.
    const res = await clone();
    expect(res.created).toBe(true);
    expect(res.projectId).toBe("p_new");
  });

  it("hands over the running image per service, since our tags exist in no registry", async () => {
    const res = await clone();
    expect(res.handover).toEqual({ web: "img/web:live", db: "img/db:live" });
  });

  it("renames nothing — the rows already carry their names", async () => {
    const res = await clone();
    expect(res.renames).toEqual({});
    expect(res.adopted).toEqual(["web", "db"]);
  });

  it("clones only the services being copied", async () => {
    await clone({ chosen: [CHOSEN[1]!] });
    expect(clonedServices().map((s) => s.sourceId)).toEqual(["svc_db"]);
  });

  it("refuses when no row matches a running container, instead of an empty project", async () => {
    await expect(
      clone({ chosen: [discovered("ghost", "v", "/x")] }),
    ).rejects.toThrow(/Services to duplicate/);
    expect(createProjectWithRecords).not.toHaveBeenCalled();
  });
});

describe("the exclusion lists are the contract", () => {
  it("names the group, so nobody 'fixes' the clone by reusing the source's", () => {
    expect(CLONE_EXCLUSIONS.project).toContain("groupId");
  });

  it("names the routing block on services", () => {
    for (const f of ["exposed", "domain", "customDomain", "publicEndpoints"]) {
      expect(CLONE_EXCLUSIONS.service).toContain(f);
    }
  });
});
