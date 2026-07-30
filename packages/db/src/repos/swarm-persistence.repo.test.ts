import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createContainerRegistryRepo } from "./container-registry.repo";
import { createServiceRepo } from "./service.repo";
import { createSwarmStackRepo } from "./swarm-stack.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function freshRepos() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // These repository tests focus ownership/upsert behavior. The independent
  // parent rows are intentionally not part of each fixture.
  await client.exec("SET session_replication_role = replica;");
  return {
    stack: createSwarmStackRepo(db),
    registry: createContainerRegistryRepo(db),
    service: createServiceRepo(db),
  };
}

describe("Swarm persistence repositories", () => {
  let repos: Awaited<ReturnType<typeof freshRepos>>;

  beforeAll(async () => {
    repos = await freshRepos();
  }, 30_000);

  it("enforces organization-scoped stack and registry reads", async () => {
    const stack = await repos.stack.create({
      id: "swarm_a",
      organizationId: "org_a",
      projectId: "project_a",
      clusterId: "cluster_a",
      stackName: "blog",
      sourceYamlEnc: "enc1:source",
    });
    await repos.registry.create({
      id: "registry_a",
      organizationId: "org_a",
      name: "internal",
      registryUrl: "registry.example.test",
      credentialsEnc: "enc1:credentials",
    });

    expect(await repos.stack.getInOrganization(stack.id, "org_b")).toBeUndefined();
    expect(await repos.registry.getInOrganization("registry_a", "org_b")).toBeUndefined();
    expect((await repos.stack.getInOrganization(stack.id, "org_a"))?.sourceYamlEnc).toBe("enc1:source");
    expect((await repos.registry.getInOrganization("registry_a", "org_a"))?.credentialsEnc).toBe("enc1:credentials");
    await expect(repos.stack.create({
      id: "swarm_foreign",
      organizationId: "org_b",
      projectId: "project_b",
      clusterId: "cluster_a",
      stackName: "blog",
    })).rejects.toThrow();
  });

  it("creates monotonic immutable revisions inside the owning organization", async () => {
    const first = await repos.stack.createRevisionInOrganization("swarm_a", "org_a", {
      renderedYamlEnc: "enc1:first",
      renderedDigest: "sha256:first",
      manifest: { web: { image: "nginx@sha256:first" } },
    });
    const second = await repos.stack.createRevisionInOrganization("swarm_a", "org_a", {
      renderedYamlEnc: "enc1:second",
      renderedDigest: "sha256:second",
      manifest: { web: { image: "nginx@sha256:second" } },
    });

    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    expect(await repos.stack.createRevisionInOrganization("swarm_a", "org_b", {
      renderedYamlEnc: "enc1:other",
      renderedDigest: "sha256:other",
    })).toBeUndefined();
  });

  it("updates authoritative source only for the owning organization and expected version", async () => {
    const first = await repos.stack.updateSourceInOrganization("swarm_a", "org_a", 1, {
      sourceKind: "repository",
      sourcePaths: ["compose.yaml", "deploy/production.yaml"],
      sourcePath: ".",
      sourceBranch: "main",
      sourceCommitSha: "a1b2c3d4",
      sourceYamlEnc: null,
      sourceDigest: "sha256:source-a",
    });
    expect(first).toMatchObject({ sourceVersion: 2, sourcePaths: ["compose.yaml", "deploy/production.yaml"] });
    expect(await repos.stack.updateSourceInOrganization("swarm_a", "org_a", 1, {
      sourceKind: "adopted", sourcePaths: [], sourcePath: null, sourceBranch: null,
      sourceCommitSha: null, sourceYamlEnc: null, sourceDigest: null,
    })).toBeUndefined();
    expect(await repos.stack.updateSourceInOrganization("swarm_a", "org_b", 2, {
      sourceKind: "adopted", sourcePaths: [], sourcePath: null, sourceBranch: null,
      sourceCommitSha: null, sourceYamlEnc: null, sourceDigest: null,
    })).toBeUndefined();
  });

  it("preserves a service row when its observed Swarm service ID changes or source removes it", async () => {
    await repos.service.syncSwarmProjections("project_a", [
      {
        sourceServiceName: "web",
        observedServiceId: "service_old",
        mode: "replicated",
        sourceDigest: "sha256:rendered-a",
        sourceState: "present",
      },
    ]);
    await repos.service.syncSwarmProjections("project_a", [
      {
        sourceServiceName: "web",
        observedServiceId: "service_new",
        mode: "replicated",
        sourceState: "present",
      },
    ]);

    const current = await repos.service.listByProjectKind("project_a", "swarm");
    expect(current).toHaveLength(1);
    expect(current[0]?.swarmProjection).toMatchObject({
      observedServiceId: "service_new",
      sourceDigest: "sha256:rendered-a",
      sourceState: "present",
    });

    await repos.service.syncSwarmProjections("project_a", []);
    const retained = await repos.service.listByProjectKind("project_a", "swarm");
    expect(retained).toHaveLength(1);
    expect(retained[0]?.swarmProjection).toMatchObject({ sourceState: "removed" });
  });

  it("lists managed bindings for the internal batched refresh scheduler only", async () => {
    await repos.stack.updateInOrganization("swarm_a", "org_a", { managementMode: "managed" });
    const managed = await repos.stack.listManaged();
    expect(managed.map((stack) => stack.id)).toContain("swarm_a");
  });
});
