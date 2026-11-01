/** Real Docker Node/PHP: signed notice → isolated probe → notification → shared
 * deployment pipeline → version/digest verification. Only GitHub feed transport,
 * signing trust and the location of the test daemon are substituted. No exploits,
 * published ports, customer resources or production signing keys are used. */
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { db, repos, schema, eq, type Project, type Service } from "@repo/db";
import { securitySigningBytes, type SecurityAdvisory } from "@repo/core";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";
import source from "../../../../security-advisories.json";

const h = vi.hoisted(() => ({ key: "" }));
vi.mock("@repo/platform/engine/modules/github/github.token", () => ({
  tokenFor: async () => null,
}));
vi.mock("@repo/platform/engine/modules/updates/security-signature", async (original) => {
  const real =
    await original<typeof import("@repo/platform/engine/modules/updates/security-signature")>();
  return {
    verifySecurityManifest: (proof: unknown, options: object) =>
      real.verifySecurityManifest(proof, { ...options, publicKey: h.key }),
  };
});

// Keep the tested patch versions stable as upstream releases advance. These are
// mutable tags; the initial snapshot replays the old artifact behind the same
// saved reference, then refresh acquires the real patched registry image.
const CASES = [
  {
    name: "node",
    old: "node:22.23.3-alpine",
    image: "node:22.23.4-alpine",
    version: "22.23.3",
    fixed: "22.23.4",
    advisory: "CVE-2026-111497-node",
    commandArgv: [
      "node",
      "-e",
      'require("http").createServer((q,s)=>s.end(process.version)).listen(8080,"127.0.0.1")',
    ],
  },
  {
    name: "php",
    old: "php:8.4.26-cli-alpine",
    image: "php:8.4.27-cli-alpine",
    version: "8.4.26",
    fixed: "8.4.27",
    advisory: "PHP-2026-10-21-rce",
    commandArgv: [
      "sh",
      "-c",
      `mkdir -p /tmp/www; printf '%s' '<?php echo PHP_VERSION;' > /tmp/www/index.php; exec php -S 127.0.0.1:8080 -t /tmp/www`,
    ],
  },
];

describeDockerE2E("signed security advisories through real Node.js and PHP deployments", () => {
  let runtime: DockerRuntime;
  let project: Project;
  let services: Service[];
  let owner: Awaited<ReturnType<typeof seedOrg>>;
  let ctx: ReturnType<typeof buildBackgroundContext>;
  let updates: typeof import("@repo/platform/engine/modules/updates/security.service");
  let builds: typeof import("@repo/platform/engine/modules/deployments/build.service");
  let initialId: string;
  let channelId: string;
  let proof: object;
  let revision = Date.now();
  const keys = generateKeyPairSync("ed25519");
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const signed = (advisories: SecurityAdvisory[]) => {
    const payload = JSON.stringify({
      format: 1,
      revision: ++revision,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      advisories,
    });
    return {
      payload,
      signature: sign(null, Buffer.from(securitySigningBytes(payload)), keys.privateKey).toString(
        "base64",
      ),
    };
  };
  const publish = async (advisories: SecurityAdvisory[]) => {
    proof = signed(advisories);
    await db
      .update(schema.advisoryFeed)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(schema.advisoryFeed.id, "security"));
  };
  async function settle(id: string) {
    const deadline = Date.now() + 120_000;
    let lastStatus: string | undefined;
    let lastLogCount = -1;
    const { getSession } =
      await import("@repo/platform/engine/modules/deployments/session-manager");
    while (true) {
      const row = await repos.deployment.findById(id);
      const session = await repos.deployment.findBuildSessionByDeploymentId(id);
      const live = getSession(id);
      if (row?.status !== lastStatus || (live?.logs?.length ?? 0) !== lastLogCount) {
        lastLogCount = live?.logs?.length ?? 0;
        console.info("[security-e2e] live", live?.logs?.slice(-3));
        console.info("[security-e2e] deployment", id, row?.status, session?.logs?.slice(-5));
        lastStatus = row?.status;
      }
      if (
        row?.status === "ready" &&
        !(await repos.deployment.listInFlightByProject(project.id)).length
      )
        break;
      if (
        ["failed", "cancelled", "partial_failure", "action_required"].includes(row?.status ?? "") ||
        Date.now() > deadline
      )
        throw new Error(
          JSON.stringify({
            status: row?.status,
            error: row?.errorMessage,
            logs: live?.logs ?? session?.logs,
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect((await repos.project.findById(project.id))?.activeDeploymentId).toBe(id);
    return repos.service.listByDeployment(id);
  }
  async function container(serviceId: string, deploymentId: string) {
    const row = (await repos.service.listByDeployment(deploymentId)).find(
      (s) => s.serviceId === serviceId,
    )!;
    expect(row?.containerId).toBeTruthy();
    const inspect = await runtime.docker.getContainer(row.containerId!).inspect();
    expect(inspect.State.Running).toBe(true);
    await vi.waitFor(
      async () => {
        expect(
          (await runtime.docker.getContainer(row.containerId!).inspect()).State.Health?.Status,
        ).toBe("healthy");
      },
      { timeout: 20_000, interval: 250 },
    );
    expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((value) => !value)).toBe(true);
    for (const mount of inspect.Mounts ?? [])
      if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
    for (const name of Object.keys(inspect.NetworkSettings.Networks ?? {})) networks.add(name);
    return { row, inspect, exec: await runtime.inContainerExecutor(row.containerId!) };
  }
  beforeAll(async () => {
    console.info("[security-e2e] preparing isolated runtime");
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    for (const fixture of CASES) await runtime.pullImage(fixture.old);
    console.info("[security-e2e] seeding project");
    owner = await seedOrg();
    ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.organizationId });
    project = await seedProject(owner.organizationId, {
      framework: "docker-compose",
      gitProvider: "upload",
      runtimeMode: "docker",
      hasBuild: false,
      hasServer: false,
      workloadType: "worker",
      rollbackWindow: 1,
    });
    services = [];
    for (const fixture of CASES)
      services.push(
        await repos.service.create({
          projectId: project.id,
          kind: "compose",
          name: fixture.name,
          image: fixture.image,
          commandArgv: fixture.commandArgv,
          enabled: true,
          exposed: false,
          ports: [],
          volumes: [`data_${fixture.name}:/data`],
          environment: { SECURITY_TEST_TOKEN: "test-only-preserved-value" },
          restart: "unless-stopped",
          advanced: {
            healthcheck: {
              test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080"],
              interval: "1s",
              timeout: "1s",
              retries: 20,
            },
          },
        }),
      );
    const channel = await repos.notificationChannel.create({
      userId: owner.userId,
      kind: "in_app",
      label: "Security E2E inbox",
      config: {},
      enabled: true,
      verified: true,
    });
    channelId = channel.id;
    const located = {
      platform: {
        target: "selfhosted",
        runtime,
        routing: new NoopInfraProvider(),
        ssl: new NoopInfraProvider(),
        system: null,
        executor: createHostExecutor(),
      },
      effectiveTarget: "local",
      runtimeMode: "docker",
      usesManagedRouting: false,
      serverId: null,
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    };
    vi.doMock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
      ...(await original<object>()),
      resolveDeploymentPlatform: async () => located,
      resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
      resolveDeploymentRuntimeForRead: async () => ({ runtime, serverId: null }),
      withDeploymentRuntime: async (_dep: unknown, work: (r: DockerRuntime) => unknown) =>
        work(runtime),
    }));
    vi.doMock("@repo/platform/engine/lib/platform-config", async (original) => ({
      ...(await original<object>()),
      platform: () => located.platform,
    }));
    // The real edge is intentionally absent: no service has public routing.
    vi.doMock("@repo/adapters", async (original) => ({
      ...(await original<object>()),
      getPlatform: () => located.platform,
      edgeProxyFor: () => ({ listLoopbackUpstreamPortsStrict: async () => new Set<number>() }),
    }));
    h.key = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    proof = signed([]);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (
        url.includes(
          "api.github.com/repos/oblien/openship/contents/security-advisories.signed.json",
        )
      )
        return Response.json(proof, { headers: { etag: `"${revision}"` } });
      if (url === "https://api.github.com/repos/oblien/openship/releases/latest")
        return Response.json({ tag_name: "v0.9.3" });
      if (url.startsWith("https://raw.githubusercontent.com/oblien/openship/"))
        return url.endsWith("/CHANGELOG.md")
          ? new Response("## 0.9.3\nFixture.")
          : Response.json({ advisories: [] });
      return realFetch(input, init);
    });
    console.info("[security-e2e] loading deployment pipeline");
    builds = await import("@repo/platform/engine/modules/deployments/build.service");
    updates = await import("@repo/platform/engine/modules/updates/security.service");
    const { projectServicesToDeployableServices } =
      await import("@repo/platform/engine/modules/deployments/compose/project-services");
    // Replay the actual old image artifacts while keeping the user's mutable tag.
    // This models a deployment made before the tag's patch, without retagging any host image.
    console.info("[security-e2e] deploying vulnerable fixtures");
    const result = await builds.triggerDeployment(ctx, {
      projectId: project.id,
      forceAll: true,
      reuseSnapshot: {
        envVars: null,
        meta: {
          ...builds.buildConfigSnapshot(project, "main"),
          ...(await builds.resolveSnapshotTarget(project)),
          composeServices: projectServicesToDeployableServices(services),
          handoverImages: Object.fromEntries(CASES.map((f) => [f.name, f.old])),
        },
      },
    });
    initialId = result.deployment.id;
    console.info("[security-e2e] waiting for vulnerable fixtures", initialId);
    await settle(initialId);
    for (const [i, fixture] of CASES.entries()) {
      const live = await container(services[i]!.id, initialId);
      expect((await live.exec.exec("wget -qO- http://127.0.0.1:8080")).trim()).toContain(
        fixture.version,
      );
      await live.exec.exec("printf preserved-data > /data/security-e2e.txt");
    }
  }, 300_000);

  afterAll(async () => {
    const { drainDeploymentExecutions } =
      await import("@repo/platform/engine/modules/deployments/deployment-cancellation");
    await drainDeploymentExecutions();
    vi.unstubAllGlobals();
    if (runtime && project) {
      for (const id of await runtime.listProjectContainerIds(project.id)) {
        const info = await runtime.docker.getContainer(id).inspect();
        for (const mount of info.Mounts ?? [])
          if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
        for (const name of Object.keys(info.NetworkSettings.Networks ?? {})) networks.add(name);
        await runtime.destroy(id);
      }
      for (const name of networks)
        if (name.includes(project.slug!)) await runtime.docker.getNetwork(name).remove();
      for (const name of volumes) await runtime.docker.getVolume(name).remove();
      expect(await runtime.listProjectContainerIds(project.id)).toEqual([]);
    }
    await runtime?.dispose();
  }, 180_000);

  it("detects real affected runtimes only after publication and delivers one notice per finding", async () => {
    const probe = vi.spyOn(runtime, "inContainerExecutor");
    const before = await updates.projectSecurityStatus(ctx, project.id);
    expect(before.findings).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    await publish(source.advisories as SecurityAdvisory[]);
    await updates.scanSecurityAdvisories();
    const status = await updates.projectSecurityStatus(ctx, project.id);
    expect(status.autoRefresh).toBe(false);
    for (const [i, fixture] of CASES.entries())
      expect(status.findings).toContainEqual(
        expect.objectContaining({
          id: fixture.advisory,
          serviceId: services[i]!.id,
          confidence: "confirmed",
          evidence: [`${fixture.name} ${fixture.version}`],
        }),
      );
    expect(probe).toHaveBeenCalledTimes(2);
    await updates.scanSecurityAdvisories();
    await updates.projectSecurityStatus(ctx, project.id);
    expect(probe).toHaveBeenCalledTimes(2);
    const { processQueuedNotifications } =
      await import("@repo/platform/engine/lib/notification-workers");
    await processQueuedNotifications();
    const deliveries = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.channelId, channelId));
    expect(deliveries).toHaveLength(status.findings.length);
    expect(deliveries.every((d) => d.status === "sent")).toBe(true);
    expect((await repos.project.findById(project.id))?.activeDeploymentId).toBe(initialId);
    probe.mockRestore();
  });

  it("automatically patches PHP only with consent and a signed fixed digest, retaining the configuration warning", async () => {
    const activeId = (await repos.project.findById(project.id))!.activeDeploymentId!;
    const { getProjectRuntimeImages } =
      await import("@repo/platform/engine/modules/updates/runtime-image-check");
    const images = await getProjectRuntimeImages(ctx, project.id);
    const php = images.images.find((i) => i.serviceId === services[1]!.id)!;
    expect(php.currentDigest).toMatch(/^sha256:/);
    const { resolveLatestImageDigest } = await import("@repo/platform/engine/lib/image-registry");
    const fixed = await resolveLatestImageDigest(CASES[1]!.image, { refresh: true });
    expect(fixed).toMatch(/^sha256:/);
    const notice: SecurityAdvisory = {
      ...(source.advisories.find((a) => a.id === CASES[1]!.advisory)! as SecurityAdvisory),
      id: "fixture-php-image-patch",
      targets: [
        {
          kind: "image",
          repository: "docker.io/library/php",
          affectedDigests: [php.currentDigest!],
          affectedTags: [],
          fixedDigests: [fixed!],
        },
      ],
    };
    await publish([...(source.advisories as SecurityAdvisory[]), notice]);
    await updates.scanSecurityAdvisories();
    expect((await repos.project.findById(project.id))!.activeDeploymentId).toBe(activeId);
    expect(await repos.deployment.listInFlightByProject(project.id)).toEqual([]);
    await updates.setProjectSecurityPolicy(ctx, project.id, { autoRefresh: true });
    const input = { advisoryId: notice.id, deploymentId: activeId, serviceId: services[1]!.id };
    const results = await Promise.all([
      updates.applySecurityAdvisory(ctx, project.id, input, true),
      updates.applySecurityAdvisory(ctx, project.id, input, true),
    ]);
    const admitted = results.filter(Boolean);
    expect(admitted).toHaveLength(1);
    const nextId = admitted[0]!.deployment_id!;
    await settle(nextId);
    const live = await container(services[1]!.id, nextId);
    expect(live.row.imageRef).toBe(`docker.io/library/php@${fixed}`);
    expect(await live.exec.exec("wget -qO- http://127.0.0.1:8080")).toContain(CASES[1]!.fixed);
    expect(await live.exec.exec("cat /data/security-e2e.txt")).toBe("preserved-data");
    expect(await live.exec.exec("printenv SECURITY_TEST_TOKEN")).toContain(
      "test-only-preserved-value",
    );
    await updates.reconcileSecurityRefreshes();
    const attempts = await db
      .select()
      .from(schema.securityRefreshAttempt)
      .where(eq(schema.securityRefreshAttempt.projectId, project.id));
    expect(attempts).toContainEqual(
      expect.objectContaining({ status: "verified", deploymentId: nextId }),
    );
    const status = await updates.projectSecurityStatus(ctx, project.id, undefined, true);
    expect(status.findings.some((f) => f.id === CASES[1]!.advisory)).toBe(false);
    expect(status.findings.find((f) => f.id === "CVE-2026-115560-php-review")?.canRefresh).toBe(
      false,
    );
    expect(status.findings.some((f) => f.id === CASES[0]!.advisory)).toBe(true);
    expect((await repos.service.findById(services[1]!.id))?.image).toBe(CASES[1]!.image);
  }, 300_000);

  it("manually refreshes Node on the same tag, preserves data/env, and rechecks the running version", async () => {
    const oldId = (await repos.project.findById(project.id))!.activeDeploymentId!;
    const phpBefore = await container(services[1]!.id, oldId);
    const result = await updates.applySecurityAdvisory(ctx, project.id, {
      advisoryId: CASES[0]!.advisory,
      deploymentId: oldId,
      serviceId: services[0]!.id,
    });
    expect(result?.deployment_id).toBeTruthy();
    const nextId = result!.deployment_id!;
    await settle(nextId);
    const next = await container(services[0]!.id, nextId);
    expect(next.row.containerId).not.toBe(
      (await repos.service.listByDeployment(oldId)).find((r) => r.serviceId === services[0]!.id)
        ?.containerId,
    );
    expect(await next.exec.exec("wget -qO- http://127.0.0.1:8080")).toContain(CASES[0]!.fixed);
    expect(await next.exec.exec("cat /data/security-e2e.txt")).toBe("preserved-data");
    expect(await next.exec.exec("printenv SECURITY_TEST_TOKEN")).toContain(
      "test-only-preserved-value",
    );
    expect((await container(services[1]!.id, nextId)).row.containerId).toBe(
      phpBefore.row.containerId,
    );
    expect((await repos.service.findById(services[0]!.id))?.image).toBe(CASES[0]!.image);
    const status = await updates.projectSecurityStatus(ctx, project.id);
    expect(status.findings.some((f) => f.id === CASES[0]!.advisory)).toBe(false);
    expect(status.findings.some((f) => f.id === CASES[1]!.advisory)).toBe(false);
    await expect(
      updates.applySecurityAdvisory(ctx, project.id, {
        advisoryId: CASES[0]!.advisory,
        deploymentId: initialId,
        serviceId: services[0]!.id,
      }),
    ).rejects.toThrow(/active deployment changed/);
  });
});
