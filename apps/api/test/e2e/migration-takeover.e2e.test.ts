/**
 * Desktop/control plane → SSH → Docker Compose → edge takeover, with real
 * databases, containers, certificates and HTTP requests. The target owns its
 * own nested Docker daemon, so this never takes over the developer's host.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { DockerRuntime, initPlatform, type CommandExecutor } from "@repo/adapters";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg } from "../helpers/seed";
import { availablePort, sshReady } from "../helpers/migration-host";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { discoverServerStack } from "@repo/platform/engine/modules/migration/docker-inspect.service";
import {
  migrationOrchestrator,
  type StartMigrationInput,
} from "@repo/platform/engine/modules/migration/migration.orchestrator";
import { revealServiceEnvVars } from "@repo/platform/engine/modules/services/service.service";
import { applyProjectEdgeRoutes } from "@repo/platform/engine/modules/domains/project-edge.service";
import { removeDomain } from "@repo/platform/engine/modules/domains/domain.service";
import { ENV_MASK } from "@repo/platform/engine/lib/secret-env";
import { pinnedEdgeImage } from "@repo/platform/engine/lib/edge-image";

const run = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/migration-target");
const SECRET = "literal ${UNCHANGED} $value 'quoted'\nsecond=line";
const names = [
  "shop.migration.test",
  "www.migration.test",
  "api.migration.test",
  "outside.migration.test",
  "paths.migration.test",
];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T | null | undefined>,
  timeout = 180_000,
): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await delay(300);
  }
  throw new Error("Timed out waiting for the migration target");
}

describeDockerE2E("Compose migration through a remote SSH server", () => {
  let ctx: ExecutionContext;
  let executor: CommandExecutor;
  let serverId: string;
  let temp: string;
  let targetId: string;
  let input: StartMigrationInput;
  let adoptedProjectId: string;
  const image = `openship-migration-test-target:${process.pid}`;
  let builtEdgeImage: string | undefined;

  beforeAll(async () => {
    await requireDocker();
    temp = await mkdtemp(join(tmpdir(), "openship-migration-test-"));
    await initPlatform({ target: "desktop", bare: { workDir: join(temp, "workloads") } });
    const identity = join(temp, "identity");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    await run("docker", ["build", "-q", "-t", image, fixture], {
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const port = await availablePort();
    targetId = (
      await run("docker", ["create", "--privileged", "-p", `127.0.0.1:${port}:22`, image])
    ).stdout.trim();
    await run("docker", ["cp", `${identity}.pub`, `${targetId}:/root/.ssh/authorized_keys`]);
    await run("docker", ["start", targetId]);
    await waitFor(async () =>
      (
        await run("docker", ["exec", targetId, "cat", "/var/run/sshd.pid"], {
          timeout: 10_000,
        }).catch(() => null)
      )?.stdout.trim(),
    );
    await waitFor(async () => ((await sshReady(port)) ? true : null), 60_000);
    // Build the real edge once on the fixture daemon and load it into its
    // nested daemon. This preserves the runtime test while reusing Docker's
    // layer cache across runs instead of downloading certbot on every retry.
    const runtime = await DockerRuntime.create({ transport: "socket" });
    const edgeImage = pinnedEdgeImage();
    try {
      const existed = await runtime.docker
        .getImage(edgeImage)
        .inspect()
        .then(
          () => true,
          (error) => {
            if (error.statusCode === 404) return false;
            throw error;
          },
        );
      const stream = await runtime.docker.buildImage(
        {
          context: join(fixture, "../../../../.."),
          src: [
            "apps/edge/Dockerfile",
            "apps/edge/nginx.conf",
            "packages/adapters/src/infra/lua",
            "apps/api/assets/geoip/GeoLite2-Country.mmdb",
          ],
        },
        { dockerfile: "apps/edge/Dockerfile", t: edgeImage },
      );
      await new Promise<void>((resolve, reject) =>
        runtime.docker.modem.followProgress(
          stream,
          (error) => (error ? reject(error) : resolve()),
          (event: { stream?: string }) => {
            if (event.stream?.trim()) console.log(`[migration-test:edge] ${event.stream.trim()}`);
          },
        ),
      );
      if (!existed) builtEdgeImage = edgeImage;
      const archive = join(temp, "edge.tar");
      await run("docker", ["save", "-o", archive, edgeImage], { timeout: 120_000 });
      await run("docker", ["cp", archive, `${targetId}:/tmp/edge.tar`], { timeout: 120_000 });
      await run("docker", ["exec", targetId, "docker", "load", "-i", "/tmp/edge.tar"], {
        timeout: 120_000,
      });
      await run("docker", ["exec", targetId, "rm", "/tmp/edge.tar"]);
    } finally {
      await runtime.dispose();
    }
    ctx = (await seedOrg()) as ExecutionContext;
    const server = await repos.server.create({
      organizationId: ctx.organizationId,
      name: "Isolated migration target",
      isLocal: false,
      sshHost: "127.0.0.1",
      sshPort: port,
      sshUser: "root",
      sshAuthMethod: "key",
      sshPrivateKey: await readFile(identity, "utf8"),
    });
    serverId = server.id;
    executor = await sshManager.acquire(serverId).catch(async (error) => {
      const logs = await run("docker", ["logs", "--tail", "25", targetId]);
      console.error(logs.stdout + logs.stderr);
      throw error;
    });
    console.log("[migration-test] SSH target ready; creating the source Compose stack");
    await executor.mkdir("/opt/migration-fixture");
    await executor.exec(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=${names[0]} -addext 'subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}' -keyout /opt/migration-fixture/key.pem -out /opt/migration-fixture/cert.pem 2>/dev/null`,
    );
    await executor.writeFile(
      "/opt/migration-fixture/tls.yml",
      "tls:\n  certificates:\n    - certFile: /certs/cert.pem\n      keyFile: /certs/key.pem\n",
    );
    const app = (
      name: string,
      rule: string,
      hostname: string,
      extraRouters: Record<string, string> = {},
    ) => ({
      image: "traefik/whoami:v1.11.0",
      hostname,
      command: ["--port=3000"],
      // Compose expands dollar expressions even in JSON. Escape them so the
      // SOURCE container really contains the literal value we will migrate.
      environment: { API_TOKEN: SECRET.replace(/\$/g, () => "$$"), APP_NAME: name },
      ...(name === "web" ? { volumes: ["fixture-data:/data"] } : {}),
      labels: {
        "traefik.enable": "true",
        "traefik.docker.network": "migration_source",
        [`traefik.http.services.${name}.loadbalancer.server.port`]: "3000",
        [`traefik.http.routers.${name}.rule`]: rule,
        [`traefik.http.routers.${name}.tls`]: "true",
        [`traefik.http.routers.${name}.service`]: name,
        ...extraRouters,
      },
      networks: ["source"],
    });
    const compose = {
      services: {
        proxy: {
          image: "traefik:v3.3",
          container_name: "migration-source-proxy",
          ports: ["80:80", "443:443"],
          command: [
            "--providers.docker=true",
            "--providers.docker.exposedbydefault=false",
            "--providers.file.filename=/certs/tls.yml",
            "--entrypoints.web.address=:80",
            "--entrypoints.websecure.address=:443",
          ],
          volumes: [
            "/var/run/docker.sock:/var/run/docker.sock:ro",
            "/opt/migration-fixture:/certs:ro",
          ],
          networks: ["source"],
        },
        web: app(
          "web",
          "Host(`shop.migration.test`) || Host(`www.migration.test`)",
          "original-frontend",
        ),
        api: app(
          "api",
          "Host(`api.migration.test`) || (Host(`shop.migration.test`) && PathPrefix(`/api`))",
          "original-backend",
          {
            "traefik.http.routers.api-paths.rule":
              "Host(`paths.migration.test`) && (PathPrefix(`/v3/`) || Path(`/mcp`))",
            "traefik.http.routers.api-paths.tls": "true",
            "traefik.http.routers.api-paths.service": "api",
          },
        ),
        outside: app("outside", "Host(`outside.migration.test`)", "unselected-outside"),
      },
      networks: { source: { name: "migration_source" } },
      volumes: { "fixture-data": {} },
    };
    await executor.writeFile("/opt/migration-fixture/compose.json", JSON.stringify(compose));
    console.log("[migration-test] Starting Traefik and three private services");
    await executor.exec(
      "docker compose -p migration-source -f /opt/migration-fixture/compose.json up -d",
      { timeout: 180_000 },
    );
    await executor.exec(
      "docker run --rm -v migration-source_fixture-data:/data alpine:3.21 sh -c 'echo source-data > /data/sentinel'",
      { timeout: 120_000 },
    );
    await waitFor(async () => ((await ask(names[0])).includes("original-frontend") ? true : null));
    const stack = await discoverServerStack(serverId, ctx.organizationId);
    console.log(
      "[migration-test] Discovery finished; checking route ownership and service identity",
    );
    expect(stack.proxy).toMatchObject({
      kind: "traefik",
      container: "migration-source-proxy",
      ours: false,
    });
    const chosen = stack.services.filter(
      (service) => service.name === "web" || service.name === "api",
    );
    expect(chosen).toHaveLength(2);
    const web = chosen.find((service) => service.name === "web")!;
    const api = chosen.find((service) => service.name === "api")!;
    expect(web.env.API_TOKEN).toBe(SECRET);
    expect(api.env.API_TOKEN).toBe(SECRET);
    expect(web.existingRoute?.flatMap((route) => route.domains).sort()).toEqual(
      [names[0], names[1]].sort(),
    );
    expect(api.existingRoute).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ containerPort: 3000, path: "/api", domains: [names[0]] }),
        expect.objectContaining({ containerPort: 3000, path: "/", domains: [names[2]] }),
        expect.objectContaining({ containerPort: 3000, path: "/v3/", domains: [names[4]] }),
        expect.objectContaining({
          containerPort: 3000,
          path: "/mcp",
          exact: true,
          domains: [names[4]],
        }),
      ]),
    );
    input = {
      organizationId: ctx.organizationId,
      sourceServerId: serverId,
      targetServerId: serverId,
      projectName: "Migrated shop",
      serviceNames: chosen.map((service) => service.name),
      serviceContainerIds: chosen.map((service) => service.containerId!),
      killOriginals: true,
      serviceRenames: { [web.containerId!]: "frontend", [api.containerId!]: "backend" },
      serviceEnv: { [web.containerId!]: { API_TOKEN: ENV_MASK, APP_NAME: "edited-in-wizard" } },
      routesByServiceName: Object.fromEntries(
        chosen.map((service) => [
          service.containerId!,
          service.existingRoute!.flatMap((route) =>
            route.domains.map((hostname) => ({
              domainType: "custom" as const,
              customDomain: hostname,
              exposedPort: String(route.containerPort),
              targetPath: route.path,
              exact: route.exact,
            })),
          ),
        ]),
      ),
    };
  }, 600_000);

  async function ask(hostname: string, path = "/") {
    return executor
      .exec(
        `curl --silent --show-error --insecure --max-time 10 --resolve ${hostname}:443:127.0.0.1 https://${hostname}${path}`,
      )
      .catch(() => "");
  }

  async function pending(id: string) {
    let lastLog = 0;
    return waitFor(async () => {
      const run = await repos.dockerMigrationRun.findById(id);
      if (run?.status === "rolled_back" || run?.status === "failed")
        throw new Error(`${run.errorMessage}\n${run.logs}`);
      if (Date.now() - lastLog > 20_000) {
        console.log(
          `[migration-test] ${run?.status}: ${run?.logs?.split("\n").slice(-3).join("\n") ?? ""}`,
        );
        lastLog = Date.now();
      }
      return migrationOrchestrator.getPendingPrompt(id);
    }, 300_000);
  }

  async function finished(id: string) {
    return waitFor(async () => {
      const run = await repos.dockerMigrationRun.findById(id);
      return run &&
        run.executionFinishedAt &&
        ["succeeded", "rolled_back", "failed"].includes(run.status)
        ? run
        : null;
    }, 300_000);
  }

  it("reviews an omitted catch-all before creating a project or changing source containers", async () => {
    const { migrationId } = await migrationOrchestrator.begin(ctx, {
      ...input,
      routesByServiceName: Object.fromEntries(
        Object.entries(input.routesByServiceName!).map(([id, routes]) => [
          id,
          (Array.isArray(routes) ? routes : [routes]).filter(
            (route) => route.customDomain !== names[0] || route.targetPath !== "/",
          ),
        ]),
      ),
    });
    const prompt = await pending(migrationId);
    expect(prompt.details?.hostnames).toEqual([names[0]]);
    expect((await repos.dockerMigrationRun.findById(migrationId))?.projectId).toBeNull();
    expect(
      await migrationOrchestrator.respondToPrompt(
        migrationId,
        ctx.organizationId,
        prompt.promptId,
        "cancel",
      ),
    ).toBe(true);
    const result = await finished(migrationId);
    expect(result.status).toBe("rolled_back");
    expect(result.projectId).toBeNull();
    expect(await ask(names[0])).toContain("original-frontend");
    for (const id of input.serviceContainerIds!)
      expect(await executor.exec(`docker inspect --format '{{.State.Running}}' ${id}`)).toContain(
        "true",
      );
  });

  it("cancels takeover without deleting the original routes or any source container", async () => {
    const { migrationId } = await migrationOrchestrator.begin(ctx, input);
    const prompt = await pending(migrationId);
    expect(prompt.details?.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectServices: expect.arrayContaining(["Migrated shop / frontend"]),
        }),
      ]),
    );
    expect(await ask(names[0])).toContain("original-frontend");
    expect(
      await migrationOrchestrator.respondToPrompt(
        migrationId,
        ctx.organizationId,
        prompt.promptId,
        "cancel",
      ),
    ).toBe(true);
    const result = await finished(migrationId);
    expect(result.status, result.errorMessage ?? undefined).toBe("rolled_back");
    if (result.projectId)
      await waitFor(async () => {
        const project = await repos.project.findById(result.projectId!);
        return !project || project.deletedAt ? true : null;
      });
    expect(await ask(names[0])).toContain("original-frontend");
    expect(await ask(names[0], "/api/orders")).toContain("original-backend");
    expect(await ask(names[3])).toContain("unselected-outside");
    for (const id of input.serviceContainerIds!)
      expect(await executor.exec(`docker inspect --format '{{.State.Running}}' ${id}`)).toContain(
        "true",
      );
  });

  it("adopts owned routes, exact environments and certificates before finishing, and keeps them consistent on retry and deletion", async () => {
    const { migrationId } = await migrationOrchestrator.begin(ctx, input);
    const prompt = await pending(migrationId);
    expect(
      await migrationOrchestrator.respondToPrompt(
        migrationId,
        ctx.organizationId,
        prompt.promptId,
        "migrate",
      ),
    ).toBe(true);
    const result = await finished(migrationId);
    expect(result.status, `${result.errorMessage}\n${result.logs}`).toBe("succeeded");
    expect(result.errorMessage).toBeNull();
    adoptedProjectId = result.projectId!;
    const services = await repos.service.listByProject(result.projectId!);
    const frontend = services.find((service) => service.name === "frontend")!;
    const backend = services.find((service) => service.name === "backend")!;
    expect(await revealServiceEnvVars(ctx, result.projectId!, frontend.id, "production")).toEqual({
      API_TOKEN: SECRET,
      APP_NAME: "edited-in-wizard",
    });
    expect(
      (await revealServiceEnvVars(ctx, result.projectId!, backend.id, "production")).API_TOKEN,
    ).toBe(SECRET);
    const domains = await repos.domain.listByProject(result.projectId!);
    expect(domains.map((domain) => domain.hostname).sort()).toEqual(
      [...names.slice(0, 3), names[4]].sort(),
    );
    for (const domain of domains)
      expect(domain).toMatchObject({
        verified: true,
        sslStatus: "active",
        serviceId:
          domain.hostname === names[4]
            ? null
            : domain.hostname === names[2]
              ? backend.id
              : frontend.id,
      });
    for (const id of input.serviceContainerIds!)
      expect(await executor.exec(`docker inspect --format '{{.State.Running}}' ${id}`)).toContain(
        "true",
      );
    expect(await ask(names[0])).toContain("original-frontend");
    expect(await ask(names[1])).toContain("original-frontend");
    expect(await ask(names[0], "/api/orders")).toContain("original-backend");
    expect(await ask(names[2])).toContain("original-backend");
    expect(await ask(names[3])).toContain("unselected-outside");
    expect(await ask(names[4], "/v3/items")).toContain("original-backend");
    expect(await ask(names[4], "/mcp")).toContain("original-backend");
    for (const path of ["/", "/private", "/mcp/child"])
      expect(
        await executor.exec(
          `curl --silent --insecure --output /dev/null --write-out '%{http_code}' --resolve ${names[4]}:443:127.0.0.1 https://${names[4]}${path}`,
        ),
      ).toBe("404");
    expect(await applyProjectEdgeRoutes(ctx, result.projectId!, { onLog: () => {} })).toEqual([]);
    expect(await ask(names[0], "/api/orders")).toContain("original-backend");
    expect(await ask(names[4], "/v3/items")).toContain("original-backend");
    await removeDomain(ctx, domains.find((domain) => domain.hostname === names[0])!.id);
    expect(await applyProjectEdgeRoutes(ctx, result.projectId!, { onLog: () => {} })).toEqual([]);
    expect(await ask(names[0])).not.toContain("original-frontend");
    expect(await ask(names[1])).toContain("original-frontend");
    expect((await repos.service.findById(frontend.id))?.exposed).toBe(true);
    await removeDomain(ctx, domains.find((domain) => domain.hostname === names[1])!.id);
    expect(await applyProjectEdgeRoutes(ctx, result.projectId!, { onLog: () => {} })).toEqual([]);
    expect(await ask(names[1])).not.toContain("original-frontend");
    expect((await repos.service.findById(frontend.id))?.exposed).toBe(false);
    expect(await ask(names[2])).toContain("original-backend");
    expect(await ask(names[3])).toContain("unselected-outside");
  });

  it("refuses an external storage writer before creating a copy or stopping the original", async () => {
    const originalId = input.serviceContainerIds![input.serviceNames.indexOf("web")]!;
    const before = await executor.exec(
      `docker inspect --format '{{.State.StartedAt}}' ${originalId}`,
    );
    await executor.exec(
      "docker run -d --name copy-external-writer -v migration-source_fixture-data:/data alpine:3.21 sleep 300",
    );
    try {
      const { migrationId } = await migrationOrchestrator.begin(ctx, {
        sourceServerId: serverId,
        targetServerId: serverId,
        projectName: "Refused shared data copy",
        organizationId: ctx.organizationId,
        killOriginals: false,
        serviceNames: ["frontend"],
        volumeStrategies: {},
        projectMove: { projectId: adoptedProjectId, intent: "copy", serviceNames: ["frontend"] },
      });
      const result = await finished(migrationId);
      expect(result.status).toBe("rolled_back");
      expect(result.errorMessage).toContain("outside this project");
      expect(result.recovery?.createdProjectId).toBeFalsy();
      expect(
        await executor.exec(`docker inspect --format '{{.State.StartedAt}}' ${originalId}`),
      ).toBe(before);
      expect(await ask(names[2])).toContain("original-backend");
    } finally {
      await executor.exec("docker rm -f copy-external-writer");
    }
  });

  it("duplicates a stateful service on the same server into independent storage without moving domains", async () => {
    const domainsBefore = (await repos.domain.listByProject(adoptedProjectId))
      .map((domain) => domain.hostname)
      .sort();
    const originalProject = await repos.project.findById(adoptedProjectId);
    const { migrationId } = await migrationOrchestrator.begin(ctx, {
      sourceServerId: serverId,
      targetServerId: serverId,
      projectName: "Independent frontend copy",
      organizationId: ctx.organizationId,
      killOriginals: false,
      serviceNames: ["frontend"],
      volumeStrategies: {},
      projectMove: { projectId: adoptedProjectId, intent: "copy", serviceNames: ["frontend"] },
    });
    const result = await finished(migrationId);
    expect(result.status, `${result.errorMessage}\n${result.logs}`).toBe("succeeded");
    expect(result.projectId).not.toBe(adoptedProjectId);
    const rows = await repos.service.listByProject(result.projectId!);
    expect(rows.map((row) => row.name)).toEqual(["frontend"]);
    expect(await repos.domain.listByProject(result.projectId!)).toEqual([]);
    const copiedVolume = rows[0]!.volumes![0]!.split(":")[0]!;
    expect(copiedVolume).not.toBe("migration-source_fixture-data");
    expect(copiedVolume).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(
      await executor.exec(
        `docker run --rm -v ${copiedVolume}:/data alpine:3.21 cat /data/sentinel`,
      ),
    ).toContain("source-data");
    await executor.exec(
      `docker run --rm -v ${copiedVolume}:/data alpine:3.21 sh -c 'echo changed-copy > /data/sentinel'`,
    );
    expect(
      await executor.exec(
        "docker run --rm -v migration-source_fixture-data:/data alpine:3.21 cat /data/sentinel",
      ),
    ).toContain("source-data");
    expect(
      (await repos.domain.listByProject(adoptedProjectId)).map((domain) => domain.hostname).sort(),
    ).toEqual(domainsBefore);
    expect((await repos.project.findById(adoptedProjectId))?.activeDeploymentId).toBe(
      originalProject?.activeDeploymentId,
    );
    expect(await ask(names[2])).toContain("original-backend");
    for (const id of input.serviceContainerIds!)
      expect(await executor.exec(`docker inspect --format '{{.State.Running}}' ${id}`)).toContain(
        "true",
      );
  });

  it("duplicates a stateless service without restarting its original container", async () => {
    const source = await repos.service.listByProject(adoptedProjectId);
    const backend = source.find((row) => row.name === "backend")!;
    const containerId = input.serviceContainerIds![input.serviceNames.indexOf("api")]!;
    const before = await executor.exec(
      `docker inspect --format '{{.State.StartedAt}}' ${containerId}`,
    );
    const { migrationId } = await migrationOrchestrator.begin(ctx, {
      sourceServerId: serverId,
      targetServerId: serverId,
      projectName: "Independent API copy",
      organizationId: ctx.organizationId,
      killOriginals: false,
      serviceNames: [backend.name],
      volumeStrategies: {},
      projectMove: { projectId: adoptedProjectId, intent: "copy", serviceNames: [backend.name] },
    });
    const result = await finished(migrationId);
    expect(result.status, `${result.errorMessage}\n${result.logs}`).toBe("succeeded");
    expect(
      await executor.exec(`docker inspect --format '{{.State.StartedAt}}' ${containerId}`),
    ).toBe(before);
    expect(await ask(names[2])).toContain("original-backend");
    expect((await repos.service.listByProject(result.projectId!)).map((row) => row.name)).toEqual([
      "backend",
    ]);
  });

  afterAll(async () => {
    if (serverId) await sshManager.invalidate(serverId);
    if (targetId) {
      const logs = await run("docker", ["logs", "--tail", "12", targetId]).catch(() => null);
      if (logs) console.log(`[migration-test] SSH target log:\n${logs.stdout}${logs.stderr}`);
    }
    if (targetId) await run("docker", ["rm", "-f", "-v", targetId]).catch(() => {});
    await run("docker", ["image", "rm", image]).catch(() => {});
    if (builtEdgeImage) await run("docker", ["image", "rm", builtEdgeImage]).catch(() => {});
    if (temp) await rm(temp, { recursive: true, force: true });
  });
});
