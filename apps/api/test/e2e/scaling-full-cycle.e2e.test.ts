/**
 * The application scaling journey through real HTTP, persistence, deployment
 * admission/pipeline, an authenticated registry, K3s and OpenShip Edge.
 *
 * Only infrastructure LOCATION is substituted: disposable containers replace
 * already-prepared remote hosts. The production adapters and their observations
 * remain real. This does not cover the SSH/systemd network/runtime installer.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import {
  DockerRuntime,
  KubernetesRuntime,
  NoopInfraProvider,
  kubernetesIdLabel,
  kubernetesProjectNamespace,
} from "@repo/adapters";
import { db, repos, schema, type Deployment, type Project } from "@repo/db";
import type { ClusterRuntimePlan } from "@repo/core";
import type { KubernetesObject } from "@repo/adapters";
import type {
  DeploymentMeta,
  ResolvedDeploymentPlatform,
} from "@repo/platform/engine/lib/deployment-runtime";
import { OpenshipClient, consumeDeploymentEvents } from "@repo/sdk/client";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";
import {
  ScalingLab,
  eventually,
  SCALING_APP_IMAGE,
  REGISTRY_USER,
  REGISTRY_PASSWORD,
  type ScalingReply,
} from "../helpers/scaling-lab";

vi.hoisted(() => {
  // Test-process-only identity; never load the developer's instance credentials.
  process.env.BETTER_AUTH_SECRET =
    "6aef2d670b7ce8eead4ba6de7f4f3b3d54a3d71b0bffb251f07f3d56a394d270";
  process.env.CLOUD_MODE = "false";
  process.env.DEPLOY_MODE = "docker";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_JOB_RUNNER = "in-process";
});

describeDockerE2E.sequential("application scaling through the complete deployment cycle", () => {
  const lab = new ScalingLab();
  let project: Project;
  let clusterId = "";
  let source = "";
  let client: OpenshipClient;
  let httpServer: ServerType | undefined;
  let baseRuntime: DockerRuntime | undefined;
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let buildSpy: ReturnType<typeof vi.spyOn>;
  let publishSpy: ReturnType<typeof vi.spyOn>;
  let streamErrors: ReturnType<typeof vi.spyOn>;
  const runtimes = new Set<KubernetesRuntime>();
  const hostname = `${lab.id}.test`;

  async function fixture(version: string, mode: "healthy" | "crash" | "waiting" = "healthy") {
    await writeFile(
      join(source, "Dockerfile"),
      [
        `FROM ${SCALING_APP_IMAGE}`,
        "WORKDIR /app",
        "COPY server.js .",
        "USER node",
        "EXPOSE 3000",
        'CMD ["node", "server.js"]',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(source, "server.js"),
      mode === "crash"
        ? 'console.error("SCALING_E2E_INTENTIONAL_CRASH"); process.exit(1);\n'
        : mode === "waiting"
          ? 'console.log("SCALING_E2E_WAITING"); setInterval(() => {}, 1000);\n'
          : [
              'const http = require("node:http");',
              'const os = require("node:os");',
              `const version = ${JSON.stringify(version)};`,
              "http.createServer((req, res) => {",
              '  res.setHeader("Content-Type", "application/json");',
              '  res.end(JSON.stringify({ version, instance: os.hostname(), setting: process.env.SCALING_SETTING || "" }));',
              '}).listen(3000, "0.0.0.0", () => console.log("SCALING_E2E_READY", version));',
              "",
            ].join("\n"),
    );
  }

  beforeAll(async () => {
    await requireDocker();
    try {
      await lab.start();
      org = await seedOrg();
      source = await mkdtemp(join(tmpdir(), "openship-scaling-source-"));
      const hosts: ClusterRuntimePlan["hosts"] = [];
      for (const [index, node] of lab.nodes.entries()) {
        const serverId = randomUUID();
        await db.insert(schema.servers).values({
          id: serverId,
          organizationId: org.organizationId,
          name: node.name,
          sshHost: node.privateIp,
        });
        hosts.push({
          serverId,
          name: node.name,
          address: node.privateIp,
          privateIp: node.privateIp,
          nodeName: node.name,
          role: index === 0 ? "server" : "agent",
          hostIdentity: null,
          interfaceName: "eth0",
          installed: true,
          ready: true,
          steps: [],
          logs: [],
        });
      }
      const network = await repos.serverCluster.create(
        org.organizationId,
        {
          name: lab.id,
          network: { mode: "native", cidrs: lab.networkCidrs, mtu: 1400, probePort: 51821 },
          members: hosts.map((host) => ({
            serverId: host.serverId,
            privateIp: host.privateIp,
            providerId: "custom" as const,
          })),
        },
        randomUUID(),
        lab.id,
      );
      const cluster = await repos.computeCluster.create(
        org.organizationId,
        {
          name: lab.id,
          networkId: network.id,
          serverIds: hosts.map((host) => host.serverId),
        },
        randomUUID(),
        lab.id,
      );
      clusterId = cluster.id;
      const plan: ClusterRuntimePlan = {
        networkId: network.id,
        networkRevision: network.revision,
        version: (await lab.api.request("GET", "/version")).gitVersion,
        podCidr: lab.podCidr,
        serviceCidr: lab.serviceCidr,
        clusterUid: (await lab.api.request("GET", "/api/v1/namespaces/kube-system")).metadata.uid,
        hosts,
      };
      // The fixture begins at a verified cluster. Runtime ownership and membership
      // guards still read the real migrated database throughout the journey.
      await db.insert(schema.clusterRuntime).values({
        id: lab.runtimeId,
        clusterId,
        organizationId: org.organizationId,
        clusterRevision: cluster.revision,
        requestId: randomUUID(),
        status: "ready",
        verifiedAt: new Date(),
        plan,
      });
      const { encryptSecretField } =
        await import("@repo/platform/engine/lib/credential-encryption");
      await repos.credential.create({
        organizationId: org.organizationId,
        provider: "docker-registry",
        name: "Scaling fixture registry",
        selector: lab.registry,
        publicFields: { username: REGISTRY_USER },
        secretsEnc: encryptSecretField(JSON.stringify({ secret: REGISTRY_PASSWORD }))!,
        status: "active",
        lastVerifiedAt: new Date(),
      });
      const { registryAuthResolver } =
        await import("@repo/platform/engine/modules/credentials/registry-auth");
      const resolveRegistryAuth = registryAuthResolver(org.organizationId);
      const edgeSourceIps = await lab.edgeSourceIps();
      const hostPortTarget = {
        targetKey: `host:${createHash("sha256").update(lab.id).digest("hex")}` as const,
        legacyTargetKeys: [],
        stable: true,
      };
      vi.doMock("@repo/platform/engine/lib/deployment-runtime", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("@repo/platform/engine/lib/deployment-runtime")>();
        return {
          ...actual,
          // Image GC and host-side route cleanup use the same prepared host.
          createServerDockerRuntime: async (
            serverId: string | undefined,
            organizationId?: string,
          ) => {
            expect(serverId).toBe(hosts[0].serverId);
            expect(organizationId).toBe(org.organizationId);
            return DockerRuntime.create({ transport: "socket", resolveRegistryAuth });
          },
          resolveServerExecutor: async (serverId: string | undefined, organizationId?: string) => {
            expect(organizationId).toBe(org.organizationId);
            const host = hosts.find((host) => host.serverId === serverId);
            if (!host)
              throw new Error("The scaling fixture cannot access a server outside its lab.");
            return {
              id: host.serverId,
              executor: lab.executor,
              isLocal: false,
              ssh: null,
              conn: { host: host.privateIp, port: 22, user: "root" },
              hostPortConnection: { sshHost: host.privateIp },
            };
          },
        };
      });
      vi.doMock("@repo/platform/engine/lib/cluster-deployment-target", async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("@repo/platform/engine/lib/cluster-deployment-target")
          >();
        const locate = async (snapshot: DeploymentMeta, organizationId?: string) => {
          expect(organizationId).toBe(org.organizationId);
          await actual.requireClusterDeploymentTarget(
            organizationId!,
            snapshot.clusterId!,
            snapshot.clusterRuntimeId,
          );
          const runtime = new KubernetesRuntime({
            api: lab.openApi(),
            projectId: snapshot.clusterProjectId!,
            runtimeId: lab.runtimeId,
            edgePrivateIp: hosts[0].privateIp,
            edgeSourceIps,
            servers: hosts,
            config: snapshot.clusterConfig!,
            resolveRegistryAuth,
            builder: () => DockerRuntime.create({ transport: "socket", resolveRegistryAuth }),
          });
          runtimes.add(runtime);
          return { runtime, serverId: hosts[0].serverId, hostPortTarget };
        };
        return {
          ...actual,
          resolveClusterDeploymentRuntime: locate,
          resolveClusterDeploymentPlatform: async (
            snapshot: DeploymentMeta,
            organizationId?: string,
          ): Promise<ResolvedDeploymentPlatform> => {
            const resolved = await locate(snapshot, organizationId);
            return {
              ...resolved,
              effectiveTarget: "cluster",
              runtimeMode: "docker",
              usesManagedRouting: true,
              platform: {
                target: "selfhosted",
                localHost: false,
                runtime: resolved.runtime,
                routing: lab.routing,
                ssl: new NoopInfraProvider(),
                system: null,
                executor: lab.executor,
              },
            };
          },
        };
      });
      baseRuntime = await DockerRuntime.create({ transport: "socket", resolveRegistryAuth });
      const base = {
        target: "selfhosted" as const,
        localHost: false,
        runtime: baseRuntime,
        routing: lab.routing,
        ssl: new NoopInfraProvider(),
        system: null,
        executor: lab.executor,
      };
      vi.doMock("@repo/platform/engine/lib/platform-config", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@repo/platform/engine/lib/platform-config")>()),
        platform: () => base,
      }));
      const { projectRoutes } = await import("../../src/modules/projects/project.routes");
      const { deploymentRoutes } = await import("../../src/modules/deployments/deployment.routes");
      const { healthRoutes } = await import("../../src/modules/health/health.routes");
      const { handleApiError } = await import("../../src/middleware/error-handler");
      const { mintPatToken } = await import("@repo/platform/engine/lib/pat");
      const pat = mintPatToken();
      await repos.personalAccessToken.create({
        userId: org.userId,
        organizationId: org.organizationId,
        name: "Scaling E2E",
        tokenPrefix: pat.tokenPrefix,
        tokenHash: pat.tokenHash,
        readOnly: false,
        scoped: false,
        expiresAt: null,
      });
      const app = new Hono()
        .onError(handleApiError)
        .route("/api/health", healthRoutes)
        .route("/api/projects", projectRoutes)
        .route("/api/deployments", deploymentRoutes);
      const address = await new Promise<number>((resolve) => {
        httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) =>
          resolve(address.port),
        );
      });
      client = new OpenshipClient({
        baseUrl: `http://127.0.0.1:${address}`,
        token: pat.token,
        organizationId: org.organizationId,
      });
      project = await seedProject(org.organizationId, {
        // A valid OpenShip ID that Kubernetes cannot use directly as a label.
        id: `proj_${lab.id}_`,
        name: "Scaling acceptance API",
        slug: lab.id,
        framework: "docker",
        gitProvider: "local",
        localPath: source,
        hasBuild: true,
        hasServer: true,
        port: 3000,
        startCommand: "",
        runtimeMode: "docker",
        rollbackWindow: 10,
      });
      await db.insert(schema.domain).values({
        id: randomUUID(),
        projectId: project.id,
        hostname,
        isPrimary: true,
        domainType: "custom",
        targetPort: 3000,
        verified: true,
        status: "active",
        externalIngress: true,
      });
      buildSpy = vi.spyOn(DockerRuntime.prototype, "build");
      publishSpy = vi.spyOn(DockerRuntime.prototype, "publishImage");
      streamErrors = vi.spyOn(console, "error");
      await fixture("v1");
    } catch (error) {
      console.error(await lab.diagnostics());
      throw error;
    }
  }, 900_000);

  afterEach(async (context) => {
    console.info(`[scaling-e2e] ${context.task.result?.state}: ${context.task.name}`);
    if (context.task.result?.state === "fail") {
      console.error(context.task.result.errors);
      if (project) {
        for (const row of (await repos.deployment.listByProject(project.id)).rows.slice(0, 3)) {
          const session = await repos.deployment.findBuildSessionByDeploymentId(row.id);
          console.error(
            JSON.stringify({
              deploymentId: row.id,
              status: row.status,
              error: row.errorMessage,
              logs: session?.logs,
            }).slice(-24_000),
          );
        }
      }
      console.error(await lab.diagnostics());
    }
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => {
      if (project && client) {
        for (const row of await repos.deployment.listInFlightByProject(project.id))
          await client.deployments.cancel(row.id);
        await eventually(
          "the fixture's deployment workers to finish",
          () => repos.deployment.listInFlightByProject(project.id),
          (rows) => rows.length === 0,
          90_000,
        );
      }
    });
    for (const runtime of runtimes) await cleanup(() => runtime.dispose());
    if (baseRuntime) await cleanup(() => baseRuntime!.dispose());
    if (httpServer?.listening)
      await cleanup(
        () =>
          new Promise<void>((resolve, reject) => {
            httpServer!.close((error) => (error ? reject(error) : resolve()));
          }),
      );
    await cleanup(() => lab.close());
    if (source) await cleanup(() => rm(source, { recursive: true, force: true }));
    vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, "Scaling fixture cleanup failed.");
  }, 120_000);

  async function finished(id: string, expected = "ready"): Promise<Deployment> {
    const outcome = await client.deployment(id).wait({ timeoutMs: 600_000, pollIntervalMs: 750 });
    if (outcome.status !== expected) {
      const session = await repos.deployment.findBuildSessionByDeploymentId(id);
      console.error(JSON.stringify(session?.logs ?? []).slice(-24_000));
      console.error(await lab.diagnostics());
    }
    expect(outcome.status, outcome.message).toBe(expected);
    await eventually(
      "deployment cleanup to finish",
      () => repos.deployment.listInFlightByProject(project.id),
      (rows) => !rows.some((row) => row.id === id),
    );
    return (await repos.deployment.findById(id))!;
  }

  async function traffic(version: string, instances: number, setting = "") {
    const observed = await eventually(
      "the requested healthy instances",
      () => client.projects.getClusterWorkload(project.id),
      (view) => view.status?.ready === instances && view.status.available === instances,
    );
    expect(observed.error).toBeNull();
    const pods = observed.status!.pods.filter((pod) => pod.ready);
    expect(pods).toHaveLength(instances);
    const replies: ScalingReply[] = [];
    const errors: string[] = [];
    await eventually(
      "each ready instance to serve through OpenShip Edge",
      async () => {
        try {
          const answer = await lab.request(hostname);
          if (answer.status !== 200) errors.push(`HTTP ${answer.status}: ${answer.body}`);
          replies.push(JSON.parse(answer.body) as ScalingReply);
        } catch (error) {
          errors.push(String(error));
        }
        return new Set(replies.map((reply) => reply.instance)).size;
      },
      (count) => count === instances,
      90_000,
    );
    // Assert every observed reply outside the retry helper: one incorrect
    // response must fail, even if later requests reach the expected instance.
    expect(errors).toEqual([]);
    for (const reply of replies) {
      expect(reply.version).toBe(version);
      expect(reply.setting).toBe(setting);
      expect(pods.some((pod) => pod.name === reply.instance)).toBe(true);
    }
    return observed;
  }

  async function whileServing(id: string, versions: string[], expected = "ready") {
    let done = false;
    const errors: string[] = [];
    let samples = 0;
    const completion = finished(id, expected).finally(() => {
      done = true;
    });
    const sampling = (async () => {
      while (!done) {
        try {
          const response = await lab.request(hostname);
          const body = JSON.parse(response.body) as ScalingReply;
          if (response.status !== 200 || !versions.includes(body.version))
            errors.push(`HTTP ${response.status}: ${response.body}`);
        } catch (error) {
          errors.push(String(error));
        }
        samples++;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const [row] = await Promise.all([completion, sampling]);
    expect(samples).toBeGreaterThan(0);
    expect(errors, "Public traffic failed while a release was changing").toEqual([]);
    return row;
  }

  it("builds, publishes, deploys, balances traffic, scales, updates and rolls back", async () => {
    const initial = await client.projects.getClusterWorkload(project.id);
    expect(initial.clusterId).toBeNull();
    await client.projects.setClusterTarget(project.id, {
      clusterId,
      config: { replicas: 1, imageRepository: lab.repository },
      expectedUpdatedAt: initial.updatedAt,
      stateless: true,
    });
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [{ key: "SCALING_SETTING", value: "release-one" }],
      deletes: [],
    });
    expect((await repos.deployment.listByProject(project.id)).rows).toHaveLength(0);
    const started = await client.deployments.buildAccess({ projectId: project.id });
    const id = started.deployment_id;

    // Closing the progress view must not stop or duplicate the deployment.
    const disconnect = new AbortController();
    const events = client.deployments
      .events(id, {
        signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(30_000)]),
      })
      [Symbol.asyncIterator]();
    try {
      expect((await events.next()).done).toBe(false);
    } finally {
      disconnect.abort();
      await events.return?.();
    }
    const [v1, replay] = await Promise.all([
      finished(id),
      consumeDeploymentEvents(
        client.deployments.events(id, {
          since: 0,
          signal: AbortSignal.timeout(600_000),
        }),
      ),
    ]);
    expect(replay.success).toBe(true);
    expect(replay.completed).toBe(true);
    expect(
      streamErrors.mock.calls
        .flat()
        .some((error: unknown) => error instanceof Error && error.name === "AbortError"),
      "Closing the progress view should not log a server error",
    ).toBe(false);
    expect(v1.imageRef).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(v1.containerId).toMatch(/^k8s:/);
    expect((await repos.deployment.listByProject(project.id)).rows).toHaveLength(1);
    await traffic("v1", 1, "release-one");
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    const beforeScale = await client.projects.getClusterWorkload(project.id);
    const scaleInput = {
      replicas: 3,
      expectedDeploymentId: beforeScale.activeDeploymentId!,
      expectedUpdatedAt: beforeScale.updatedAt,
    };
    const scaled = await client.projects.scaleClusterWorkload(project.id, scaleInput);
    await expect(
      client.projects.scaleClusterWorkload(project.id, scaleInput),
    ).rejects.toMatchObject({ status: 409 });
    const three = await whileServing(scaled.deploymentId, ["v1"]);
    expect(three.imageRef).toBe(v1.imageRef);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const acrossServers = await traffic("v1", 3, "release-one");
    expect(
      new Set(acrossServers.status!.pods.map((pod) => pod.serverId)).size,
    ).toBeGreaterThanOrEqual(2);
    expect(acrossServers.status!.pods.every((pod) => !!pod.serverName)).toBe(true);

    // Resolve the real internal service name from an application pod, across
    // CoreDNS, the Service and the project's actual ingress policy.
    const namespace = kubernetesProjectNamespace(project.id);
    const answer = await lab.nodeExec(0, [
      "kubectl",
      "exec",
      "-n",
      namespace,
      acrossServers.status!.pods[0].name,
      "--",
      "node",
      "-e",
      `fetch("http://${acrossServers.internalHost}:3000/").then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exit(1)})`,
    ]);
    expect(JSON.parse(answer).version).toBe("v1");

    await fixture("v2");
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [{ key: "SCALING_SETTING", value: "release-two" }],
      deletes: [],
    });
    const update = await client.deployments.buildAccess({ projectId: project.id });
    const v2 = await whileServing(update.deployment_id, ["v1", "v2"]);
    expect(v2.imageRef).not.toBe(v1.imageRef);
    await traffic("v2", 3, "release-two");
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenCalledTimes(2);

    const beforeDown = await client.projects.getClusterWorkload(project.id);
    const down = await client.projects.scaleClusterWorkload(project.id, {
      replicas: 1,
      expectedDeploymentId: beforeDown.activeDeploymentId!,
      expectedUpdatedAt: beforeDown.updatedAt,
    });
    expect((await whileServing(down.deploymentId, ["v2"])).imageRef).toBe(v2.imageRef);
    await traffic("v2", 1, "release-two");

    // Roll back to the three-instance v1 release, including its frozen settings.
    const known = new Set(
      (await repos.deployment.listByProject(project.id)).rows.map((row) => row.id),
    );
    // The rollback endpoint returns the selected history row; the asynchronous
    // restore creates a new release. Follow that release, never the old row.
    await client.deployments.rollback(three.id);
    const rollback = await eventually(
      "the new rollback release",
      async () =>
        (await repos.deployment.listByProject(project.id)).rows.find(
          (row) => !known.has(row.id) && row.trigger === "rollback",
        ),
      Boolean,
    );
    const restored = await whileServing(rollback!.id, ["v1", "v2"]);
    expect(restored.imageRef).toBe(v1.imageRef);
    expect(restored.trigger).toBe("rollback");
    expect((await repos.project.findById(project.id))!.activeDeploymentId).toBe(restored.id);
    await traffic("v1", 3, "release-one");
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  }, 1_200_000);

  async function pendingWorkload(id: string) {
    const namespace = kubernetesProjectNamespace(project.id);
    const stopped = (status: string) =>
      ["failed", "cancelled", "action_required", "ready"].includes(status);
    const observed = await eventually(
      "the new workload to be declared",
      async () => {
        const state = await client.deployments.buildStatus(id);
        if (stopped(state.deploymentStatus)) return { state, workload: undefined };
        const list = await lab.api.request<{ items: KubernetesObject[] }>(
          "GET",
          `/apis/apps/v1/namespaces/${namespace}/deployments?labelSelector=${encodeURIComponent(`openship.io/deployment=${kubernetesIdLabel(id)}`)}`,
        );
        return { state, workload: list.items[0] };
      },
      (value) => !!value.workload || stopped(value.state.deploymentStatus),
      120_000,
    );
    if (!observed.workload)
      throw new Error(
        `Deployment stopped before its workload was created: ${JSON.stringify(observed.state)}`,
      );
    return observed.workload;
  }

  it("keeps the active release serving through cancellation and failure, then retries explicitly", async () => {
    const active = (await client.projects.getClusterWorkload(project.id)).activeDeploymentId!;
    expect(active).toBeTruthy();
    await fixture("waiting", "waiting");
    const waiting = await client.deployments.buildAccess({ projectId: project.id });
    await pendingWorkload(waiting.deployment_id);
    await traffic("v1", 3, "release-one");
    await client.deployments.cancel(waiting.deployment_id);
    await whileServing(waiting.deployment_id, ["v1"], "cancelled");
    expect((await client.projects.getClusterWorkload(project.id)).activeDeploymentId).toBe(active);

    await fixture("broken", "crash");
    const broken = await client.deployments.buildAccess({ projectId: project.id });
    const workload = await pendingWorkload(broken.deployment_id);
    // Shorten only Kubernetes' real deadline for this intentional crash. Its
    // controller still determines failure; no status or API reply is fabricated.
    await lab.api.request(
      "PATCH",
      `/apis/apps/v1/namespaces/${kubernetesProjectNamespace(project.id)}/deployments/${workload.metadata.name}`,
      {
        metadata: { resourceVersion: workload.metadata.resourceVersion },
        spec: { progressDeadlineSeconds: 20 },
      },
    );
    const failed = await whileServing(broken.deployment_id, ["v1"], "failed");
    expect(failed.errorMessage).toMatch(/progress|ready|deadline/i);
    expect((await client.projects.getClusterWorkload(project.id)).activeDeploymentId).toBe(active);
    await traffic("v1", 3, "release-one");

    const beforeRetry = (await repos.deployment.listByProject(project.id)).rows.length;
    await fixture("v3");
    const retry = await client.deployments.redeploy(failed.id);
    const recovered = await whileServing(retry.deployment_id, ["v1", "v3"]);
    expect(recovered.id).not.toBe(failed.id);
    expect((await repos.deployment.findById(failed.id))!.status).toBe("failed");
    expect((await repos.deployment.listByProject(project.id)).rows).toHaveLength(beforeRetry + 1);
    // The project's current settings are release-two; rollback only restored
    // the old release's frozen environment.
    await traffic("v3", 1, "release-two");
  }, 600_000);

  it("serves from surviving workers and replaces a lost application instance without a new release", async () => {
    const before = await client.projects.getClusterWorkload(project.id);
    const scaled = await client.projects.scaleClusterWorkload(project.id, {
      replicas: 3,
      expectedDeploymentId: before.activeDeploymentId!,
      expectedUpdatedAt: before.updatedAt,
    });
    await whileServing(scaled.deploymentId, ["v3"]);
    const view = await traffic("v3", 3, "release-two");
    const worker = lab.nodes.find(
      (node, index) => index > 0 && view.status!.pods.some((pod) => pod.nodeName === node.name),
    )!;
    expect(worker).toBeTruthy();
    const history = (await repos.deployment.listByProject(project.id)).rows.length;
    const namespace = kubernetesProjectNamespace(project.id);
    const services = await lab.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `/api/v1/namespaces/${namespace}/services?labelSelector=${encodeURIComponent(`openship.io/deployment=${kubernetesIdLabel(scaled.deploymentId)}`)}`,
    );
    const serviceName = services.items.find(
      (service) => service.spec.selector?.["openship.io/deployment"] === kubernetesIdLabel(scaled.deploymentId),
    )?.metadata.name;
    expect(serviceName).toBeTruthy();
    const outageStarted = Date.now();
    try {
      // Kill the disposable worker as a machine outage. Restart the same node
      // afterward, preserving its identity and containerd state.
      await worker.container.kill({ signal: "SIGKILL" });
      await eventually(
        "Kubernetes to detect the unavailable worker",
        () => lab.api.request("GET", `/api/v1/nodes/${worker.name}`),
        (node) =>
          node.status.conditions.some(
            (condition: { type: string; status: string }) =>
              condition.type === "Ready" && condition.status !== "True",
          ),
        120_000,
      );
      await eventually(
        "the unavailable worker to leave service endpoints",
        () =>
          lab.api.request<{ items: KubernetesObject[] }>(
            "GET",
            `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=${encodeURIComponent(`kubernetes.io/service-name=${serviceName}`)}`,
          ),
        ({ items }) => {
          const ready = items
            .flatMap((slice) => slice.endpoints)
            .filter((endpoint) => endpoint.conditions?.ready === true);
          return ready.length > 0 && ready.every((endpoint) => endpoint.nodeName !== worker.name);
        },
      );
      // Endpoint updates and kube-proxy rules converge asynchronously after an
      // abrupt outage. Require sustained real traffic recovery within a bound;
      // a single lucky response from a surviving pod cannot pass this check.
      let consecutive = 0;
      let interrupted = 0;
      const replies: ScalingReply[] = [];
      await eventually(
        "twelve consecutive requests through surviving workers",
        async () => {
          try {
            const response = await lab.request(hostname);
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
            replies.push(JSON.parse(response.body) as ScalingReply);
            return ++consecutive;
          } catch {
            interrupted++;
            consecutive = 0;
            return 0;
          }
        },
        (count) => count === 12,
        120_000,
      );
      console.info(
        `[scaling-e2e] Worker outage recovered in ${Math.ceil((Date.now() - outageStarted) / 1000)}s; ${interrupted} interrupted requests during convergence.`,
      );
      for (const reply of replies) {
        expect(reply.version).toBe("v3");
        expect(reply.setting).toBe("release-two");
        const pod = view.status!.pods.find((pod) => pod.name === reply.instance);
        expect(pod).toBeTruthy();
        expect(pod!.nodeName).not.toBe(worker.name);
      }
    } finally {
      await worker.container.start();
    }
    const resumed = await traffic("v3", 3, "release-two");
    const lostPod = resumed.status!.pods[0].name;
    await lab.api.request(
      "DELETE",
      `/api/v1/namespaces/${kubernetesProjectNamespace(project.id)}/pods/${lostPod}`,
    );
    await eventually(
      "Kubernetes to replace the deleted instance",
      () => client.projects.getClusterWorkload(project.id),
      (state) =>
        state.status?.ready === 3 &&
        state.status.pods.length === 3 &&
        state.status.pods.every((pod) => pod.name !== lostPod && pod.ready),
    );
    await traffic("v3", 3, "release-two");
    expect((await repos.deployment.listByProject(project.id)).rows).toHaveLength(history);
    expect((await client.projects.getClusterWorkload(project.id)).activeDeploymentId).toBe(
      scaled.deploymentId,
    );
  }, 360_000);

  it("removes the application, its owned namespace and public route through normal project cleanup", async () => {
    const removed = await client.projects.remove(project.id);
    expect(removed.ok, JSON.stringify(removed.steps)).toBe(true);
    expect(removed.steps.every((step) => step.status !== "failed")).toBe(true);
    await eventually(
      "the project namespace to be removed",
      async () => {
        try {
          await lab.api.request(
            "GET",
            `/api/v1/namespaces/${kubernetesProjectNamespace(project.id)}`,
          );
          return false;
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 404) return true;
          throw error;
        }
      },
      Boolean,
    );
    expect(await repos.project.findById(project.id)).toBeFalsy();
    expect((await lab.request(hostname)).status).toBe(404);
  }, 180_000);
});
