import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, schema, repos, seedOwner, type SeededOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import * as lifecycle from "@repo/platform/engine/modules/system/network-setup-lifecycle";
import * as target from "@repo/platform/engine/lib/cluster-deployment-target";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { appConnectionRoutes } from "../../../src/modules/apps/app-connection.routes";
import { projectConnectionRoutes } from "../../../src/modules/projects/project-connection.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { seedClusterProject } from "../../helpers/cluster-project";
import { clusterDatabaseNamespace, KubernetesApiError } from "@repo/adapters";
import type {
  KubernetesObject,
  KubernetesApi,
} from "../../../../../packages/adapters/src/cluster/kubernetes-api";
import { kubernetesIdLabel } from "../../../../../packages/adapters/src/cluster/kubernetes-label";
import { sharedNativeDatabases } from "@repo/platform/engine/modules/projects/cluster-database-connections";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes)
  .route("/api/projects/:id/app-connection", appConnectionRoutes)
  .route("/api/projects/:id/connections", projectConnectionRoutes);
async function clients(owner: SeededOwner, organizationId = owner.orgId) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "native-sharing-test",
      }),
    },
  });
  const native = (await ship.scope({ identity: "verified", organizationId })).projects;
  const remote = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    organizationId,
    fetch: ((url, init) => app.request(String(url), init)) as typeof fetch,
  }).projects;
  return { native, remote };
}
async function fixture() {
  vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
  const owner = await seedOwner(),
    source = await seedClusterProject(owner),
    consumer = await seedClusterProject(owner);
  await repos.project.update(consumer.id, { clusterId: source.clusterId });
  const sdk = await clients(owner);
  const database = await sdk.native.createClusterDatabase(source.id, {
    requestId: crypto.randomUUID(),
    name: "shared-postgres",
    clusterId: source.clusterId,
    config: {
      engine: "postgres",
      mode: "standalone",
      instances: 1,
      storageClass: "openship-local",
      storageGiB: 1,
      cpuMillis: 250,
      memoryMiB: 256,
      databaseName: "app",
    },
  });
  await repos.clusterDatabase.finish(
    database.id,
    database.generation,
    "ready",
    {
      ready: true,
      message: "Verified fixture",
      observedAt: new Date().toISOString(),
      primary: "database-1",
      pods: [],
      volumes: [],
    },
    null,
  );
  const namespace = clusterDatabaseNamespace(database.id);
  const labels = {
    "openship.io/database": database.id,
    "openship.io/runtime": source.runtime.id,
    "openship.io/project": kubernetesIdLabel(source.id),
  };
  const resources = new Map<string, KubernetesObject>([
    [
      `/api/v1/namespaces/${namespace}`,
      {
        kind: "Namespace",
        metadata: { name: namespace, uid: "namespace-uid", labels },
        spec: {},
      },
    ],
  ]);
  const request = vi.fn(async (method: string, path: string, value?: KubernetesObject) => {
    if (method === "GET") {
      const found = resources.get(path);
      if (!found) throw new KubernetesApiError(404, "Missing fixture resource");
      return structuredClone(found);
    }
    const key = method === "POST" ? `${path}/${value!.metadata.name}` : path;
    const saved = {
      ...value!,
      metadata: { ...value!.metadata, uid: "policy-uid", resourceVersion: "1" },
    };
    resources.set(key, saved);
    return structuredClone(saved);
  });
  const api = { request, dispose: vi.fn(async () => {}) } as unknown as KubernetesApi;
  vi.spyOn(target, "openClusterApi").mockResolvedValue({
    api,
    runtime: source.runtime,
    gateway: source.plan.hosts[0],
    target: {},
    edgeSourceIps: [],
  } as never);
  const outputId = "cluster-database:" + database.id;
  const input = {
    sourceProjectId: source.id,
    outputId,
    envKey: "DATABASE_URL",
    mode: "internal" as const,
  };
  const policy = () =>
    resources.get(
      `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/database-ingress`,
    )!;
  return { owner, source, consumer, database, sdk, input, policy, request, resources };
}
afterEach(() => vi.restoreAllMocks());

describe("native database sharing through existing project connections", () => {
  it("shares PostgreSQL reader endpoints with the same tenant and guards the final replica", async () => {
    const f = await fixture();
    let database = await f.sdk.remote.getClusterDatabase(f.source.id, {
      databaseId: f.database.id,
    });
    database = await f.sdk.native.updateClusterDatabase(f.source.id, {
      databaseId: database.id,
      expectedSequence: database.sequence,
      config: { ...database.config, mode: "cluster", instances: 3 },
    });
    await repos.clusterDatabase.finish(
      database.id,
      database.generation,
      "ready",
      {
        ready: true,
        message: "Replicas verified",
        observedAt: new Date().toISOString(),
        primary: "database-1",
        pods: [],
        volumes: [],
      },
      null,
    );
    database = await f.sdk.remote.getClusterDatabase(f.source.id, { databaseId: database.id });
    const view = await f.sdk.remote.getAppConnection(f.source.id);
    expect(view.outputs).toHaveLength(2);
    const reader = view.outputs.find((output) => output.id === f.input.outputId + ":read")!;
    expect(reader.envKey).toBe("DATABASE_READ_URL");
    expect(reader.value).toContain("@database-ro.");
    const connection = await f.sdk.remote.createConnection(f.consumer.id, {
      ...f.input,
      outputId: reader.id,
      envKey: "DATABASE_READ_URL",
    });
    expect(
      decrypt((await repos.project.getEnvMap(f.consumer.id, "production")).DATABASE_READ_URL),
    ).toBe(reader.value);
    await f.sdk.native.createConnection(f.consumer.id, f.input);
    expect(await repos.projectConnection.listByTarget(f.consumer.id)).toHaveLength(2);
    expect(await sharedNativeDatabases(f.owner.orgId, f.consumer.id, f.source.runtime.id)).toEqual([
      { databaseId: database.id, projectId: f.source.id },
    ]);
    await expect(
      f.sdk.native.updateClusterDatabase(f.source.id, {
        databaseId: database.id,
        expectedSequence: database.sequence,
        config: { ...database.config, mode: "standalone", instances: 1 },
      }),
    ).rejects.toThrow("Disconnect applications using the reader endpoint");
    await f.sdk.native.removeConnection(f.consumer.id, connection.connection.id);
    const scaled = await f.sdk.remote.updateClusterDatabase(f.source.id, {
      databaseId: database.id,
      expectedSequence: database.sequence,
      config: { ...database.config, mode: "standalone", instances: 1 },
    });
    expect(scaled.config.instances).toBe(1);
  });

  it("shares through native and HTTP APIs, stores an encrypted reference and revokes only the chosen consumer", async () => {
    const f = await fixture();
    const view = await f.sdk.remote.getAppConnection(f.source.id);
    expect(view.outputs).toHaveLength(1);
    expect(view.outputs[0]).toMatchObject({
      sourceDatabaseId: f.database.id,
      clusterId: f.source.clusterId,
      internal: true,
      secret: true,
    });
    const created = await f.sdk.native.createConnection(f.consumer.id, f.input);
    expect(created.connection.sourceDatabaseId).toBe(f.database.id);
    const retry = await f.sdk.remote.connectBundle(f.consumer.id, {
      sourceProjectId: f.source.id,
      items: [{ outputId: f.input.outputId, envKey: f.input.envKey }],
      mode: "internal",
    });
    expect(retry.connections[0].id).toBe(created.connection.id);
    const vars = await repos.project.listEnvVars(f.consumer.id, "production", null);
    expect(vars).toHaveLength(1);
    expect(vars[0].isSecret).toBe(true);
    expect(vars[0].value).not.toBe(view.outputs[0].value);
    expect(decrypt(vars[0].value)).toBe(view.outputs[0].value);
    expect(f.policy().spec.ingress[1].from).toHaveLength(2);
    const consumer = (await repos.project.findById(f.consumer.id))!;
    await expect(
      repos.clusterRuntime.bindProject(
        f.owner.orgId,
        consumer.id,
        null,
        null,
        consumer.updatedAt.toISOString(),
      ),
    ).rejects.toThrow("Disconnect shared native databases");
    expect((await repos.project.findById(consumer.id))!.clusterId).toBe(f.source.clusterId);
    expect(
      (await repos.clusterDatabase.get(f.owner.orgId, f.source.id, f.database.id)).projectId,
    ).toBe(f.source.id);
    await expect(
      f.sdk.remote.removeClusterDatabase(f.source.id, {
        databaseId: f.database.id,
        expectedSequence: f.database.sequence,
        name: f.database.name,
        deleteData: true,
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_DATABASE_CONFLICT" });
    await f.sdk.remote.removeConnection(f.consumer.id, created.connection.id);
    expect(await repos.projectConnection.listByTarget(f.consumer.id)).toEqual([]);
    expect(await repos.project.listEnvVars(f.consumer.id, "production", null)).toEqual([]);
    expect(f.policy().spec.ingress[1].from).toHaveLength(1);
  });

  it("rejects another cluster or tenant without writing a link or network grant", async () => {
    const f = await fixture();
    const another = await seedClusterProject(f.owner);
    await expect(f.sdk.native.createConnection(another.id, f.input)).rejects.toMatchObject({
      code: "CLUSTER_CONNECTION_UNAVAILABLE",
    });
    const outsider = await seedOwner(),
      otherProject = await seedClusterProject(outsider),
      other = await clients(outsider);
    await expect(other.remote.createConnection(otherProject.id, f.input)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(await repos.projectConnection.listBySource(f.source.id)).toEqual([]);
  });

  it("requires write access to the source as well as the consumer through both APIs", async () => {
    const f = await fixture(),
      member = await seedOwner({ bound: false });
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: f.owner.orgId,
      userId: member.userId,
      role: "restricted",
    });
    for (const [resourceId, permissions] of [
      [f.source.id, ["read"]],
      [f.consumer.id, ["read", "write"]],
    ] as const)
      await repos.resourceGrant.upsert({
        organizationId: f.owner.orgId,
        userId: member.userId,
        resourceType: "project",
        resourceId,
        permissions: [...permissions],
        grantedByUserId: f.owner.userId,
      });
    const c = await clients(member, f.owner.orgId);
    for (const client of [c.native, c.remote]) {
      await expect(client.getAppConnection(f.source.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(client.createConnection(f.consumer.id, f.input)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(await repos.projectConnection.listByTarget(f.consumer.id)).toEqual([]);
    expect(await repos.project.listEnvVars(f.consumer.id, "production", null)).toEqual([]);
  });

  it("retains the binding on failed revocation and keeps other consumers on retry", async () => {
    const f = await fixture(),
      another = await seedClusterProject(f.owner);
    await repos.project.update(another.id, { clusterId: f.source.clusterId });
    const first = await f.sdk.native.createConnection(f.consumer.id, f.input);
    await f.sdk.remote.createConnection(another.id, f.input);
    expect(f.policy().spec.ingress[1].from).toHaveLength(3);
    vi.mocked(target.openClusterApi).mockRejectedValueOnce(
      new Error("Cluster is temporarily unreachable"),
    );
    await expect(
      f.sdk.remote.removeConnection(f.consumer.id, first.connection.id),
    ).rejects.toThrow();
    expect(await repos.projectConnection.listByTarget(f.consumer.id)).toHaveLength(1);
    expect(await repos.project.listEnvVars(f.consumer.id, "production", null)).toHaveLength(1);
    expect(f.policy().spec.ingress[1].from).toHaveLength(3);
    await f.sdk.remote.removeConnection(f.consumer.id, first.connection.id);
    expect(await repos.projectConnection.listByTarget(f.consumer.id)).toEqual([]);
    expect(f.policy().spec.ingress[1].from[1].podSelector.matchLabels["openship.io/project"]).toBe(
      kubernetesIdLabel(another.id),
    );
    expect(await sharedNativeDatabases(f.owner.orgId, another.id, f.source.runtime.id)).toEqual([
      { databaseId: f.database.id, projectId: f.source.id },
    ]);
    expect(await sharedNativeDatabases(f.owner.orgId, f.consumer.id, f.source.runtime.id)).toEqual(
      [],
    );
    await expect(
      sharedNativeDatabases(f.owner.orgId, another.id, "another-runtime"),
    ).rejects.toMatchObject({ code: "CLUSTER_CONNECTION_UNAVAILABLE" });
  });

  it("retries a failed grant without duplicating links and revokes the previous database on replacement", async () => {
    const f = await fixture();
    vi.mocked(target.openClusterApi).mockRejectedValueOnce(
      new Error("Cluster is temporarily unreachable"),
    );
    await expect(f.sdk.remote.createConnection(f.consumer.id, f.input)).rejects.toThrow();
    const [saved] = await repos.projectConnection.listByTarget(f.consumer.id);
    expect(saved.sourceDatabaseId).toBe(f.database.id);
    expect(f.policy()).toBeUndefined();
    const retried = await f.sdk.native.createConnection(f.consumer.id, f.input);
    expect(retried.connection.id).toBe(saved.id);
    const replacement = await f.sdk.native.createClusterDatabase(f.source.id, {
      requestId: crypto.randomUUID(),
      name: "replacement",
      clusterId: f.source.clusterId,
      config: f.database.config,
    });
    await repos.clusterDatabase.finish(
      replacement.id,
      replacement.generation,
      "ready",
      {
        ready: true,
        message: "Verified replacement fixture",
        observedAt: new Date().toISOString(),
        primary: "database-1",
        pods: [],
        volumes: [],
      },
      null,
    );
    const replacementNamespace = clusterDatabaseNamespace(replacement.id);
    f.resources.set(`/api/v1/namespaces/${replacementNamespace}`, {
      kind: "Namespace",
      metadata: {
        name: replacementNamespace,
        uid: "replacement-namespace",
        labels: {
          "openship.io/database": replacement.id,
          "openship.io/runtime": f.source.runtime.id,
          "openship.io/project": kubernetesIdLabel(f.source.id),
        },
      },
    });
    const next = { ...f.input, outputId: "cluster-database:" + replacement.id };
    vi.mocked(target.openClusterApi).mockRejectedValueOnce(new Error("Revocation unavailable"));
    await expect(f.sdk.remote.createConnection(f.consumer.id, next)).rejects.toThrow();
    expect((await repos.projectConnection.listByTarget(f.consumer.id))[0].sourceDatabaseId).toBe(
      f.database.id,
    );
    expect(f.policy().spec.ingress[1].from).toHaveLength(2);
    await f.sdk.remote.createConnection(f.consumer.id, next);
    expect(f.policy().spec.ingress[1].from).toHaveLength(1);
    expect(
      f.resources.get(
        `/apis/networking.k8s.io/v1/namespaces/${replacementNamespace}/networkpolicies/database-ingress`,
      )!.spec.ingress[1].from,
    ).toHaveLength(2);
    expect((await repos.projectConnection.listByTarget(f.consumer.id))[0]).toMatchObject({
      id: saved.id,
      sourceDatabaseId: replacement.id,
    });
    const [env] = await repos.project.listEnvVars(f.consumer.id, "production", null);
    expect(decrypt(env.value)).toContain(replacementNamespace);
  });
});
