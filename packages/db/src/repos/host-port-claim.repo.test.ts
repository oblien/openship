import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { EXCLUDED_TABLES } from "../dump";
import {
  createHostPortClaimRepo,
  HostPortClaimConflictError,
  type HostPortClaimIdentity,
  type HostPortTargetKey,
} from "./host-port-claim.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const CLAIM_MIGRATION = resolve(MIGRATIONS_DIR, "0111_host_port_claim.sql");

async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { client, db, repo: createHostPortClaimRepo(db) };
}

type Fixture = Awaited<ReturnType<typeof freshDb>>;

const QUARANTINE_OWNER = "__host_port_quarantine__";

async function rerunClaimMigration(fixture: Fixture): Promise<void> {
  for (const statement of readFileSync(CLAIM_MIGRATION, "utf8").split(
    /-->\s*statement-breakpoint/i,
  )) {
    if (statement.trim()) await fixture.client.exec(statement);
  }
}

const claim = (over: Partial<HostPortClaimIdentity> = {}): HostPortClaimIdentity => ({
  targetKey: "local",
  port: 20_000,
  projectId: "project-a",
  serviceId: null,
  containerPort: 3_000,
  ...over,
});

describe("host-port claims", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await freshDb();
  }, 30_000);

  afterEach(async () => {
    await fixture.client.close();
  });

  it("lists a physical target across owners while isolating a different target", async () => {
    await fixture.repo.reserveHostPortClaim(claim());
    await fixture.repo.reserveHostPortClaim(
      claim({ port: 20_001, projectId: "project-from-another-org" }),
    );
    await fixture.repo.reserveHostPortClaim(
      claim({ targetKey: "server:srv-a", projectId: "remote-project" }),
    );

    expect(await fixture.repo.listHostPortClaims("local")).toMatchObject([
      { port: 20_000, projectId: "project-a" },
      { port: 20_001, projectId: "project-from-another-org" },
    ]);
    expect(await fixture.repo.listHostPortClaims("server:srv-a")).toMatchObject([
      { port: 20_000, projectId: "remote-project" },
    ]);
  });

  it("is idempotent for the same exact owner and port", async () => {
    const first = await fixture.repo.reserveHostPortClaim(claim());
    const second = await fixture.repo.reserveHostPortClaim(claim());

    expect(second.id).toBe(first.id);
    expect(await fixture.repo.listHostPortClaims("local")).toHaveLength(1);
  });

  it("atomically refines a matching legacy scalar with its observed container port", async () => {
    const legacy = await fixture.repo.reserveHostPortClaim(claim({ containerPort: null }));
    const refined = await fixture.repo.reserveHostPortClaim(claim({ containerPort: 8_080 }));

    expect(refined).toMatchObject({
      id: legacy.id,
      projectId: legacy.projectId,
      serviceId: legacy.serviceId,
      port: legacy.port,
      containerPort: 8_080,
    });
    expect(await fixture.repo.listHostPortClaims("local")).toHaveLength(1);
  });

  it("does not refine a legacy scalar over an existing exact owner", async () => {
    await fixture.repo.reserveHostPortClaim(claim({ port: 20_001, containerPort: 8_080 }));
    await fixture.repo.reserveHostPortClaim(claim({ port: 20_000, containerPort: null }));

    await expect(
      fixture.repo.reserveHostPortClaim(claim({ port: 20_000, containerPort: 8_080 })),
    ).rejects.toMatchObject({
      code: "HOST_PORT_CLAIM_CONFLICT",
      conflict: "owner",
    } satisfies Partial<HostPortClaimConflictError>);
  });

  it("keeps the quarantine identity unreachable through workload reservations", async () => {
    await expect(
      fixture.repo.reserveHostPortClaim(
        claim({
          projectId: QUARANTINE_OWNER,
          serviceId: QUARANTINE_OWNER,
          containerPort: 20_000,
        }),
      ),
    ).rejects.toThrow("reserved for internal use");

    await expect(
      fixture.repo.reserveQuarantinedHostPortClaim({ targetKey: "local", port: 20_000 }),
    ).resolves.toMatchObject({
      projectId: QUARANTINE_OWNER,
      serviceId: QUARANTINE_OWNER,
      containerPort: 20_000,
      port: 20_000,
    });
  });

  it("releases quarantine only through the exact internal target/port operation", async () => {
    await fixture.repo.reserveQuarantinedHostPortClaim({ targetKey: "local", port: 20_000 });
    await fixture.repo.reserveQuarantinedHostPortClaim({
      targetKey: "server:srv-a",
      port: 20_000,
    });

    await expect(
      fixture.repo.releaseHostPortClaim(
        claim({
          projectId: QUARANTINE_OWNER,
          serviceId: QUARANTINE_OWNER,
          containerPort: 20_000,
        }),
      ),
    ).rejects.toThrow("reserved for internal use");
    await expect(
      fixture.repo.releaseQuarantinedHostPortClaim({ targetKey: "local", port: 20_001 }),
    ).resolves.toBe(false);
    await expect(
      fixture.repo.releaseQuarantinedHostPortClaim({ targetKey: "local", port: 20_000 }),
    ).resolves.toBe(true);
    await expect(
      fixture.repo.releaseQuarantinedHostPortClaim({ targetKey: "local", port: 20_000 }),
    ).resolves.toBe(false);

    expect(await fixture.repo.listHostPortClaims("local")).toEqual([]);
    expect(await fixture.repo.listHostPortClaims("server:srv-a")).toHaveLength(1);
  });

  it("rejects another owner for the same target and port but permits another target", async () => {
    await fixture.repo.reserveHostPortClaim(claim());

    await expect(
      fixture.repo.reserveHostPortClaim(claim({ projectId: "project-b" })),
    ).rejects.toMatchObject({
      code: "HOST_PORT_CLAIM_CONFLICT",
      conflict: "port",
    } satisfies Partial<HostPortClaimConflictError>);

    await expect(
      fixture.repo.reserveHostPortClaim(
        claim({ targetKey: "server:srv-a", projectId: "project-b" }),
      ),
    ).resolves.toMatchObject({ targetKey: "server:srv-a", port: 20_000 });
  });

  it("rejects a second port for the same stable target owner", async () => {
    await fixture.repo.reserveHostPortClaim(claim());

    await expect(fixture.repo.reserveHostPortClaim(claim({ port: 20_001 }))).rejects.toMatchObject({
      code: "HOST_PORT_CLAIM_CONFLICT",
      conflict: "owner",
    } satisfies Partial<HostPortClaimConflictError>);
  });

  it("distinguishes every routed container port, including bare single apps", async () => {
    await fixture.repo.reserveHostPortClaim(
      claim({ serviceId: "service-a", containerPort: 8_080 }),
    );
    await fixture.repo.reserveHostPortClaim(
      claim({ serviceId: "service-a", containerPort: 9_090, port: 20_001 }),
    );
    await fixture.repo.reserveHostPortClaim(
      claim({ projectId: "bare-project", containerPort: 4_000, port: 4_000 }),
    );

    expect(await fixture.repo.listHostPortClaims("local")).toMatchObject([
      { projectId: "bare-project", serviceId: null, containerPort: 4_000, port: 4_000 },
      { serviceId: "service-a", containerPort: 8_080, port: 20_000 },
      { serviceId: "service-a", containerPort: 9_090, port: 20_001 },
    ]);
  });

  it("keeps detached/stopped claims without requiring project or service rows", async () => {
    const detached = await fixture.repo.reserveHostPortClaim(
      claim({
        projectId: "already-deleted-project",
        serviceId: "already-deleted-service",
        containerPort: 8_080,
      }),
    );

    expect(detached.projectId).toBe("already-deleted-project");
    expect(await fixture.repo.listHostPortClaims("local")).toContainEqual(detached);
  });

  it("uses the unique target/port index as the concurrent final arbiter", async () => {
    const results = await Promise.allSettled([
      fixture.repo.reserveHostPortClaim(claim({ projectId: "racer-a" })),
      fixture.repo.reserveHostPortClaim(claim({ projectId: "racer-b" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await fixture.repo.listHostPortClaims("local")).toHaveLength(1);
  });

  it("backfills canonical legacy, bare, and multi-port claims before the first redeploy", async () => {
    await fixture.client.exec("SET session_replication_role = replica;");

    await fixture.db.insert(schema.servers).values([
      {
        id: "srv-local-alias",
        organizationId: "org-seed",
        sshHost: "127.0.0.1",
        isLocal: true,
      },
      {
        id: "srv-remote",
        organizationId: "org-seed",
        sshHost: "203.0.113.10",
        isLocal: false,
      },
      {
        id: "srv-implicit-remote",
        organizationId: "org-implicit-remote",
        sshHost: "203.0.113.11",
        isLocal: false,
      },
      {
        id: "srv-implicit-local",
        organizationId: "org-implicit-local",
        sshHost: "127.0.0.1",
        isLocal: true,
      },
    ]);

    const seedProject = async (
      id: string,
      options: {
        organizationId?: string;
        serverId?: string | null;
        hostPort?: number | null;
        port?: number;
        runtimeMode?: "bare" | "docker";
        hasServer?: boolean;
        cloudWorkspaceId?: string | null;
        active?: boolean;
        status?: string;
        metaServerId?: string;
        deployTarget?: "local" | "server" | "cloud";
      } = {},
    ) => {
      const organizationId = options.organizationId ?? "org-seed";
      const deploymentId = `dep-${id}`;
      await fixture.db.insert(schema.deployment).values({
        id: deploymentId,
        projectId: id,
        organizationId,
        branch: "main",
        status: options.status ?? "ready",
        meta: {
          runtimeMode: options.runtimeMode ?? "docker",
          ...(options.metaServerId ? { serverId: options.metaServerId } : {}),
          ...(options.deployTarget
            ? { deployTarget: options.deployTarget }
            : options.cloudWorkspaceId
              ? { deployTarget: "cloud" }
              : {}),
        },
      });
      await fixture.db.insert(schema.project).values({
        id,
        organizationId,
        groupId: `app-${id}`,
        name: id,
        slug: id,
        serverId: options.serverId ?? null,
        hostPort: options.hostPort ?? null,
        port: options.port ?? 3_000,
        runtimeMode: options.runtimeMode ?? "docker",
        hasServer: options.hasServer ?? true,
        cloudWorkspaceId: options.cloudWorkspaceId ?? null,
        activeDeploymentId: options.active === false ? null : deploymentId,
      });
      return deploymentId;
    };

    await seedProject("legacy-local", { hostPort: 21_001 });
    await seedProject("legacy-local-alias", {
      serverId: "srv-local-alias",
      hostPort: 21_002,
    });
    await seedProject("legacy-remote", {
      serverId: "srv-remote",
      hostPort: 21_003,
    });
    await seedProject("legacy-meta-remote", {
      metaServerId: "srv-remote",
      hostPort: 21_004,
    });
    await seedProject("legacy-implicit-remote", {
      organizationId: "org-implicit-remote",
      deployTarget: "server",
      hostPort: 21_009,
    });
    await seedProject("legacy-implicit-local", {
      organizationId: "org-implicit-local",
      deployTarget: "server",
      hostPort: 21_010,
    });
    await seedProject("legacy-cloud-pin", {
      cloudWorkspaceId: "cloud-workspace-pin",
      hostPort: 21_014,
    });
    await seedProject("bare-local", { runtimeMode: "bare", port: 3_101 });
    await seedProject("bare-local-alias", {
      serverId: "srv-local-alias",
      runtimeMode: "bare",
      port: 3_102,
    });
    await seedProject("bare-implicit-remote", {
      organizationId: "org-implicit-remote",
      deployTarget: "server",
      runtimeMode: "bare",
      port: 3_105,
    });
    await seedProject("bare-static", {
      runtimeMode: "bare",
      port: 3_103,
      hasServer: false,
    });
    await seedProject("bare-cloud", {
      runtimeMode: "bare",
      port: 3_104,
      cloudWorkspaceId: "cloud-workspace",
    });

    const composeDeployment = await seedProject("compose-remote", {
      serverId: "srv-remote",
    });
    await fixture.db.insert(schema.serviceDeployment).values([
      {
        id: "sd-compose-map",
        deploymentId: composeDeployment,
        serviceId: "service-map",
        status: "success",
        hostPort: 21_005,
        hostPorts: { "8080": 21_005, "9090": 21_006 },
      },
      {
        id: "sd-compose-legacy",
        deploymentId: composeDeployment,
        serviceId: "service-legacy",
        status: "success",
        hostPort: 21_007,
        hostPorts: null,
      },
    ]);

    const inFlightDeployment = await seedProject("compose-in-flight", {
      serverId: "srv-remote",
      active: false,
      status: "deploying",
    });
    await fixture.db.insert(schema.serviceDeployment).values({
      id: "sd-compose-in-flight",
      deploymentId: inFlightDeployment,
      serviceId: "service-in-flight",
      status: "pending",
      hostPorts: { "7070": 21_008 },
    });

    const implicitComposeDeployment = await seedProject("compose-implicit-remote", {
      organizationId: "org-implicit-remote",
      deployTarget: "server",
    });
    await fixture.db.insert(schema.serviceDeployment).values({
      id: "sd-compose-implicit-remote",
      deploymentId: implicitComposeDeployment,
      serviceId: "service-implicit-remote",
      status: "success",
      hostPort: 21_011,
      hostPorts: { "6060": 21_011 },
    });

    const cloudComposeDeployment = await seedProject("compose-cloud", {
      cloudWorkspaceId: "cloud-workspace-compose",
    });
    await fixture.db.insert(schema.serviceDeployment).values({
      id: "sd-compose-cloud",
      deploymentId: cloudComposeDeployment,
      serviceId: "service-cloud",
      status: "success",
      hostPort: 21_012,
      hostPorts: { "8080": 21_012 },
    });

    // A self-hosted local-build cloud snapshot has no durable cloud workspace
    // binding, so deployTarget itself must keep its source-host cache unclaimed.
    const localBuildCloudDeployment = await seedProject("compose-local-build-cloud", {
      deployTarget: "cloud",
    });
    await fixture.db.insert(schema.serviceDeployment).values({
      id: "sd-compose-local-build-cloud",
      deploymentId: localBuildCloudDeployment,
      serviceId: "service-local-build-cloud",
      status: "success",
      hostPort: 21_013,
      hostPorts: { "8080": 21_013 },
    });

    // Re-running 0111 is safe because every DDL statement is IF NOT EXISTS and
    // every backfill is conflict-tolerant. Here it exercises the data migration
    // against legacy-shaped rows that could not exist before the fresh migrate.
    await rerunClaimMigration(fixture);

    expect(await fixture.repo.listHostPortClaims("local")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "legacy-local",
          port: 21_001,
          containerPort: null,
        }),
        expect.objectContaining({
          projectId: "legacy-local-alias",
          port: 21_002,
          containerPort: null,
        }),
        expect.objectContaining({
          projectId: "legacy-implicit-local",
          port: 21_010,
          containerPort: null,
        }),
        expect.objectContaining({
          projectId: "bare-local",
          port: 3_101,
          containerPort: 3_101,
        }),
        expect.objectContaining({
          projectId: "bare-local-alias",
          port: 3_102,
          containerPort: 3_102,
        }),
      ]),
    );
    expect(await fixture.repo.listHostPortClaims("local")).toHaveLength(5);

    expect(await fixture.repo.listHostPortClaims("server:srv-remote")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: "legacy-remote", port: 21_003 }),
        expect.objectContaining({ projectId: "legacy-meta-remote", port: 21_004 }),
        expect.objectContaining({
          serviceId: "service-map",
          containerPort: 8_080,
          port: 21_005,
        }),
        expect.objectContaining({
          serviceId: "service-map",
          containerPort: 9_090,
          port: 21_006,
        }),
        expect.objectContaining({
          serviceId: "service-legacy",
          containerPort: null,
          port: 21_007,
        }),
        expect.objectContaining({
          serviceId: "service-in-flight",
          containerPort: 7_070,
          port: 21_008,
        }),
      ]),
    );
    expect(await fixture.repo.listHostPortClaims("server:srv-remote")).toHaveLength(6);

    expect(await fixture.repo.listHostPortClaims("server:srv-implicit-remote")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "legacy-implicit-remote",
          port: 21_009,
          containerPort: null,
        }),
        expect.objectContaining({
          projectId: "bare-implicit-remote",
          port: 3_105,
          containerPort: 3_105,
        }),
        expect.objectContaining({
          projectId: "compose-implicit-remote",
          serviceId: "service-implicit-remote",
          containerPort: 6_060,
          port: 21_011,
        }),
      ]),
    );
    expect(await fixture.repo.listHostPortClaims("server:srv-implicit-remote")).toHaveLength(3);

    const localPorts = (await fixture.repo.listHostPortClaims("local")).map((row) => row.port);
    expect(localPorts.filter((port) => [21_012, 21_013, 21_014].includes(port))).toEqual([]);
  });

  it("quarantines every port involved in ambiguous persisted ownership", async () => {
    await fixture.client.exec("SET session_replication_role = replica;");

    const seedDeployment = async (input: {
      projectId: string;
      deploymentId: string;
      serviceDeploymentId: string;
      serviceId: string;
      hostPort: number;
      deploymentStatus?: string;
      active?: boolean;
    }) => {
      await fixture.db.insert(schema.deployment).values({
        id: input.deploymentId,
        projectId: input.projectId,
        organizationId: "org-collision",
        branch: "main",
        status: input.deploymentStatus ?? "ready",
        meta: { runtimeMode: "docker" },
      });
      if (input.active !== false) {
        await fixture.db.insert(schema.project).values({
          id: input.projectId,
          organizationId: "org-collision",
          groupId: `app-${input.projectId}`,
          name: input.projectId,
          slug: input.projectId,
          activeDeploymentId: input.deploymentId,
          runtimeMode: "docker",
        });
      }
      await fixture.db.insert(schema.serviceDeployment).values({
        id: input.serviceDeploymentId,
        deploymentId: input.deploymentId,
        serviceId: input.serviceId,
        status: "success",
        hostPort: input.hostPort,
        // Exact shape 0110 creates while upgrading a scalar-only legacy row.
        hostPorts: { __legacy__: input.hostPort },
      });
    };

    // The advisory state: two projects have persisted vhosts for one loopback
    // port. Neither owner may win arbitrarily — the port must be unclaimable.
    await seedDeployment({
      projectId: "collision-a",
      deploymentId: "dep-collision-a",
      serviceDeploymentId: "sd-collision-a",
      serviceId: "service-collision-a",
      hostPort: 20_000,
    });
    await seedDeployment({
      projectId: "collision-b",
      deploymentId: "dep-collision-b",
      serviceDeploymentId: "sd-collision-b",
      serviceId: "service-collision-b",
      hostPort: 20_000,
    });

    // One stable service owner also cannot be assigned whichever of two ports
    // happens to sort first. Preserve both until the interrupted reconcile is
    // repaired, because either port may still be named by a live vhost.
    await seedDeployment({
      projectId: "owner-drift",
      deploymentId: "dep-owner-active",
      serviceDeploymentId: "sd-owner-active",
      serviceId: "service-owner-drift",
      hostPort: 20_001,
    });
    await seedDeployment({
      projectId: "owner-drift",
      deploymentId: "dep-owner-reconciling",
      serviceDeploymentId: "sd-owner-reconciling",
      serviceId: "service-owner-drift",
      hostPort: 20_002,
      deploymentStatus: "reconciling",
      active: false,
    });

    await rerunClaimMigration(fixture);

    expect(
      (await fixture.repo.listHostPortClaims("local")).map((row) => ({
        port: row.port,
        projectId: row.projectId,
        serviceId: row.serviceId,
        containerPort: row.containerPort,
      })),
    ).toEqual([
      {
        port: 20_000,
        projectId: QUARANTINE_OWNER,
        serviceId: QUARANTINE_OWNER,
        containerPort: 20_000,
      },
      {
        port: 20_001,
        projectId: QUARANTINE_OWNER,
        serviceId: QUARANTINE_OWNER,
        containerPort: 20_001,
      },
      {
        port: 20_002,
        projectId: QUARANTINE_OWNER,
        serviceId: QUARANTINE_OWNER,
        containerPort: 20_002,
      },
    ]);

    await expect(
      fixture.repo.reserveHostPortClaim({
        targetKey: "local",
        port: 20_000,
        projectId: "collision-a",
        serviceId: "service-collision-a",
        containerPort: null,
      }),
    ).rejects.toMatchObject({ conflict: "port" });
  });

  it("releases exact claims and ignores a stale/wrong-owner release", async () => {
    await fixture.repo.reserveHostPortClaim(claim());

    await expect(
      fixture.repo.releaseHostPortClaim(claim({ projectId: "wrong-owner" })),
    ).resolves.toBe(false);
    await expect(fixture.repo.releaseHostPortClaim(claim())).resolves.toBe(true);
    await expect(fixture.repo.releaseHostPortClaim(claim())).resolves.toBe(false);
  });

  it("prunes a service to its authoritative routed-port map and bulk-releases it", async () => {
    for (const [containerPort, port] of [
      [8_080, 20_000],
      [9_090, 20_001],
      [9_091, 20_002],
    ] as const) {
      await fixture.repo.reserveHostPortClaim(
        claim({ serviceId: "service-a", containerPort, port }),
      );
    }

    await expect(
      fixture.repo.pruneHostPortClaimsForOwner({
        targetKey: "local",
        projectId: "project-a",
        serviceId: "service-a",
        keep: [
          { containerPort: 8_080, port: 20_000 },
          { containerPort: 9_091, port: 20_002 },
        ],
      }),
    ).resolves.toBe(1);
    expect((await fixture.repo.listHostPortClaims("local")).map((row) => row.port)).toEqual([
      20_000, 20_002,
    ]);

    await expect(
      fixture.repo.releaseHostPortClaimsForOwner({
        targetKey: "local",
        projectId: "project-a",
        serviceId: "service-a",
      }),
    ).resolves.toBe(2);
    expect(await fixture.repo.listHostPortClaims("local")).toEqual([]);
  });

  it("rejects malformed target keys and out-of-range ports before SQL", async () => {
    await expect(fixture.repo.listHostPortClaims("server:" as HostPortTargetKey)).rejects.toThrow(
      /targetKey/,
    );
    await expect(fixture.repo.reserveHostPortClaim(claim({ port: 70_000 }))).rejects.toThrow(
      /port must be an integer/,
    );
  });

  it("is explicitly excluded from every dump/clone/transfer catalogue", () => {
    expect(EXCLUDED_TABLES.host_port_claim).toMatch(/physical-target port reservations/);
  });
});
