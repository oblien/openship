/** Explicit staging-only provider smoke test. Creates ONE capped, temporary
 * namespace/workspace, and deletes both in finally. This tests infrastructure;
 * it does not fulfil a checkout or claim to test the paid customer lifecycle.
 *
 * bun packages/adapters/scripts/verify-cloud-docker.ts --staging-env apps/api/.env.local-saas
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Oblien } from "../src/oblien";
import { CloudDockerRuntime } from "../src/runtime/cloud/docker";
import { CloudInfraProvider } from "../src/infra/cloud";
import { isDockerWorkspaceRunning, waitForCloudDockerWorkspace } from "../src/runtime/cloud/workspace-ready";
import { deleteCloudWorkspace } from "../src/runtime/cloud/workspace-delete";
import { BuildLogger } from "../src/runtime/build-pipeline";
import type { CloudAdminProxy } from "../src/runtime/cloud";
import type { BuildConfig, ProvisionLock } from "../src/types";
import type { MultiServiceDeployConfig } from "../src/runtime/types";

if (process.argv[2] !== "--staging-env" || !process.argv[3]) {
  throw new Error("Provide --staging-env with a confirmed staging/test credential file");
}
const configuration = parseEnv(await readFile(process.argv[3], "utf8"));
const domainFlag = process.argv.indexOf("--public-domain");
const publicDomain = domainFlag >= 0 ? process.argv[domainFlag + 1]! : "opsh.io";
if (!publicDomain || !/^[a-z0-9.-]+$/.test(publicDomain)) throw new Error("Invalid public test domain");
const baseUrl = configuration.OBLIEN_API_URL || "https://api.oblien.com";
if (!configuration.OBLIEN_CLIENT_ID || !configuration.OBLIEN_CLIENT_SECRET || new URL(baseUrl).protocol !== "https:") {
  throw new Error("Missing staging credentials or HTTPS provider URL");
}
const admin = new Oblien({ clientId: configuration.OBLIEN_CLIENT_ID, clientSecret: configuration.OBLIEN_CLIENT_SECRET, baseUrl });
const tag = `os-docker-smoke-${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const directory = await mkdtemp(join(tmpdir(), "openship-cloud-smoke-"));
const manifest = join(directory, "resources.json");
let namespaceId: string | undefined;
let workspaceId: string | undefined;
let runtime: CloudDockerRuntime | undefined;
const pages = new Set<string>();
const report: Array<{ check: string; passed: boolean }> = [];
const log = (check: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), check, ...details }));
const check = (name: string, condition: unknown) => {
  report.push({ check: name, passed: Boolean(condition) });
  if (!condition) throw new Error(`Smoke check failed: ${name}`);
  log(name, { passed: true });
};
const abort = new AbortController();
const stop = () => { abort.abort(new Error("Staging smoke interrupted")); void runtime?.dispose(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const save = () => writeFile(manifest, JSON.stringify({ namespace: tag, namespaceId, workspaceId, pages: [...pages] }), { mode: 0o600 });
let tail: Promise<unknown> = Promise.resolve();
const provisionLock: ProvisionLock = {
  run(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; },
};
try {
  log("creating isolated staging namespace", { manifest });
  const created = await admin.namespaces.create({ name: tag, slug: tag, type: "testing",
    resource_limits: { max_workspaces: 1, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 32 } });
  namespaceId = created.data.id;
  await save();
  // A finite test allowance on this NEW namespace only. Customer checkout and
  // every account/default/other-namespace policy remain untouched.
  await admin.billing.setPolicy(tag, { quotaLimit: 100, overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" });
  const token = await admin.tokens.create({ scope: "namespace", namespace: tag, ttl: 1800 });
  const client = new Oblien({ token: token.token, baseUrl });
  const createOptions = { namespace: tag, name: tag, slug: tag, image: "oblien/docker:29", mode: "temporary" as const,
    wait_ready: false, idempotency_key: tag,
    config: { cpus: 2, memory_mb: 4096, disk_size_mb: 32768, ttl: "20m", ttl_action: "remove" as const,
      remove_on_exit: false, wait_for_init: true, network_config: { allow_internet: true, public_ingress: false } } };
  const workspace = await client.workspaces.create(createOptions);
  workspaceId = workspace.id;
  await save();
  check("workspace created in test namespace", workspace.namespace === tag && workspaceId);
  const replay = await client.workspaces.create(createOptions);
  check("provider idempotency reuses workspace", replay.id === workspaceId);
  const progress = setInterval(() => log("waiting for Docker workspace"), 20_000);
  try { await waitForCloudDockerWorkspace(client, workspaceId, tag, { signal: abort.signal }); }
  finally { clearInterval(progress); }
  log("Docker workspace ready");
  await client.workspace(workspaceId).lifecycle.makePermanent();
  check("project workspace can be made permanent", (await client.workspaces.get(workspaceId)).mode === "permanent");
  await client.workspace(workspaceId).lifecycle.makeTemporary({ ttl: "20m", ttl_action: "remove", remove_on_exit: false });
  const pageMethods = ["list", "get", "create", "deploy", "delete", "enable", "disable", "getDomain", "connectDomain", "disconnectDomain", "checkDNS", "renewSSL"] as const;
  const adminPages = Object.fromEntries(pageMethods.map(method => [method, admin.pages[method].bind(admin.pages)])) as NonNullable<CloudAdminProxy["pages"]>;
  adminPages.list = async () => { const result = await admin.pages.list(); return { ...result, pages: result.pages.filter(page => page.namespace === tag) }; };
  adminPages.create = async input => {
    if (input.workspace_id !== workspaceId || !input.slug?.startsWith(tag)) throw new Error("Smoke route escaped its workspace");
    pages.add(input.slug);
    await save();
    return admin.pages.create({ ...input, namespace: tag });
  };
  const adminProxy: CloudAdminProxy = { pages: adminPages, createPage: adminPages.create,
    domainRoutes: async () => { const result = await admin.domain.routes({ namespace: tag }); return { ...result, data: result.data.filter(route => route.namespace === tag) }; },
    setRoutes: (hostname, input) => {
      if (!hostname.startsWith(`${tag}.`) && !hostname.startsWith(`${tag}-`)) throw new Error("Smoke route escaped its project");
      return admin.routes.set(hostname, input);
    } };
  runtime = await CloudDockerRuntime.forWorkspace(client, {
    workspaceId, projectId: tag, namespace: tag, provisionLock, allowHostSource: true, publicDomain,
    resolveRegistryAuth: async () => undefined,
    adminProxy,
  });
  log("connecting Docker API");
  check("Docker API ping through authenticated bridge", await runtime.docker.ping());
  const raw = await runtime.executor.rawExec(String.raw`printf '\000\001\377\n\r'`);
  const bytes: Buffer[] = [];
  for await (const chunk of raw.stdout) bytes.push(Buffer.from(chunk));
  const binaryExit = await raw.onClose;
  log("binary fixture result", { exit: binaryExit, hex: Buffer.concat(bytes).toString("hex") });
  check("workspace execution preserves binary bytes", binaryExit === 0 && Buffer.concat(bytes).equals(Buffer.from([0, 1, 255, 10, 13])));

  const source = join(directory, "source");
  await (await import("node:fs/promises")).mkdir(source);
  await writeFile(join(source, "Dockerfile"), "FROM busybox:1.37\nARG REVISION=v1\nRUN printf '%s' \"$REVISION\" > /revision\nCOPY start.sh /start.sh\nCMD [\"sh\", \"/start.sh\"]\n");
  await writeFile(join(source, "start.sh"), "set -eu\nmkdir -p /data /secondary\ntest -f /data/index.html || printf 'persistent-v1' > /data/index.html\nprintf 'secondary-port' > /secondary/index.html\nhttpd -p 9090 -h /secondary\nexec httpd -f -p 8080 -h /data\n");
  const config: BuildConfig = { sessionId: `bld_${tag}-v1`, projectId: tag, slug: tag, repoUrl: "", branch: "main",
    localPath: source, stack: "docker", buildImage: "busybox:1.37", runtimeImage: "busybox:1.37",
    packageManager: "npm", installCommand: "", buildCommand: "", startCommand: "", outputDirectory: ".",
    rootDirectory: ".", hasServer: true, port: 8080, productionPaths: [], envVars: {},
    resources: { cpuCores: 1, memoryMb: 512, diskMb: 1024 } };
  const buildLog: string[] = [];
  const built = await runtime.build(config, new BuildLogger(entry => {
    buildLog.push(entry.message);
    if (buildLog.length > 1000) buildLog.shift();
  }));
  await writeFile(join(directory, "build.log"), buildLog.join(""), { mode: 0o600 });
  check("source builds inside workspace", built.status === "deploying" && built.imageRef);
  const group = await runtime.ensureServiceGroup({ projectId: tag, deploymentId: `${tag}-d1`, slug: tag });
  const service: MultiServiceDeployConfig = { projectId: tag, deploymentId: `${tag}-d1`, slug: tag,
    serviceName: "web", image: built.imageRef!, imageAlreadyPrepared: true, environment: {},
    ports: [], publicPort: 8080, volumes: ["data:/data"], namespaceVolumes: true,
    advanced: { healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080"] } },
    cloudEndpoints: [
      { hostname: `${tag}.${publicDomain}`, port: 8080, custom: false },
      { hostname: `${tag}-api.${publicDomain}`, port: 9090, custom: false },
    ] };
  const first = await runtime.deployServiceWorkload(group, service);
  check("container and distinct public ports", first.containerId !== workspaceId && first.hostPortByContainerPort?.[8080] !== first.hostPortByContainerPort?.[9090]);
  let routesApplied = !first.routeWarnings?.length;
  if (!routesApplied) {
    log("route warnings", { warnings: first.routeWarnings });
    try {
      for (const endpoint of service.cloudEndpoints!) await runtime.publishRoute(endpoint.hostname, first.hostPortByContainerPort![endpoint.port]!, endpoint.custom);
      routesApplied = true;
    } catch (error) {
      log("route registration failed", { message: error instanceof Error ? error.message : "Unknown provider error", code: (error as { code?: string }).code });
      check("edge routes applied", false);
    }
  }
  const internal = await runtime.deployServiceWorkload(group, { ...service, serviceName: "internal", volumes: ["internal:/data"],
    cloudEndpoints: [], publicPort: undefined });
  check("internal service has no published ports", Object.keys(internal.hostPortByContainerPort ?? {}).length === 0);
  const shell = await runtime.inContainerExecutor(first.containerId);
  check("service DNS on shared network", (await shell.exec("wget -qO- http://internal:8080")).includes("persistent-v1"));
  await shell.exec("printf 'survives-redeploy' > /data/index.html");
  const archive = await runtime.docker.getContainer(first.containerId).getArchive({ path: "/data" });
  let archiveBytes = 0;
  const archiveChunks: Buffer[] = [];
  for await (const chunk of archive) { archiveBytes += Buffer.byteLength(chunk); archiveChunks.push(Buffer.from(chunk)); }
  check("streaming volume archive", archiveBytes >= 1024);
  await shell.exec("printf 'after-backup' > /data/index.html");
  await runtime.docker.getContainer(first.containerId).putArchive(Buffer.concat(archiveChunks), { path: "/" });
  check("volume backup restores original bytes", (await shell.exec("cat /data/index.html")) === "survives-redeploy");
  await runtime.getRuntimeLogs(first.containerId, 10);
  await runtime.getUsage(first.containerId);
  check("logs and usage", true);
  const nextBuild = await runtime.build({ ...config, sessionId: `bld_${tag}-v2`, buildArgs: { REVISION: "v2" } });
  check("second application image builds inside workspace", nextBuild.status === "deploying" && nextBuild.imageRef !== built.imageRef);
  let second = await runtime.deployServiceWorkload(group, { ...service, deploymentId: `${tag}-d2`, image: nextBuild.imageRef! });
  check("redeploy replaces only selected container", second.containerId !== first.containerId && (await runtime.getContainerInfo(internal.containerId)).status === "running");
  check("named volume survives redeploy", (await (await runtime.inContainerExecutor(second.containerId)).exec("cat /data/index.html")) === "survives-redeploy");
  check("published ports survive redeploy", JSON.stringify(first.hostPortByContainerPort) === JSON.stringify(second.hostPortByContainerPort));
  check("redeploy runs the new image", (await (await runtime.inContainerExecutor(second.containerId)).exec("cat /revision")) === "v2");
  const superseded = second;
  second = await runtime.deployServiceWorkload(group, { ...service, deploymentId: `${tag}-rollback` });
  const restoredShell = await runtime.inContainerExecutor(second.containerId);
  check("rollback uses the retained image", (await restoredShell.exec("cat /revision")) === "v1");
  check("rollback preserves data and sibling service", (await restoredShell.exec("cat /data/index.html")) === "survives-redeploy" &&
    (await runtime.getContainerInfo(internal.containerId)).status === "running");
  await runtime.purge({ id: `${tag}-d2`, containerId: superseded.containerId, imageRef: nextBuild.imageRef! } as never);
  check("retention removes only the superseded image", await runtime.docker.getImage(nextBuild.imageRef!).inspect().then(() => false, error => error.statusCode === 404));
  await runtime.stop(second.containerId);
  check("service stop preserves workspace and sibling", isDockerWorkspaceRunning(await client.workspaces.get(workspaceId)) && (await runtime.getContainerInfo(internal.containerId)).status === "running");
  await runtime.start(second.containerId);
  check("edge routes applied", routesApplied && !second.routeWarnings?.length);
  const publicText = async (hostname: string) => {
    let last = "";
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response = await fetch(`https://${hostname}/`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
        last = await response.text();
        if (response.ok && /survives-redeploy|secondary-port/.test(last)) return last;
      } catch { /* Edge propagation or DNS can lag the successful route write. */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return last;
  };
  check("public HTTPS serves primary service port", (await publicText(`${tag}.${publicDomain}`)).includes("survives-redeploy"));
  check("public HTTPS serves secondary service port", (await publicText(`${tag}-api.${publicDomain}`)).includes("secondary-port"));
  await client.workspace(workspaceId).stop();
  log("workspace stopped for recovery check", { status: (await client.workspaces.get(workspaceId)).status });
  check("stopped workspace reads do not start compute", (await runtime.getContainerInfo(second.containerId)).status === "stopped");
  await runtime.start(second.containerId);
  check("workspace restart preserves the volume", (await (await runtime.inContainerExecutor(second.containerId)).exec("cat /data/index.html")) === "survives-redeploy");
  check("bridge recovery reuses its workload", (await client.workspace(workspaceId).workloads.list({ name: "openship-docker-api-v1" })).length === 1);
  const hostnames = await runtime.listProjectRouteHostnames();
  log("project route inventory", { hostnames, registry: (await admin.domain.routes({ namespace: tag })).data
    .filter(route => route.namespace === tag || route.hostname.startsWith(tag))
    .map(route => ({ hostname: route.hostname, namespace: route.namespace, owner_type: route.owner_type, owner_id: route.owner_id })) });
  check("cleanup finds both project route owners", hostnames.includes(`${tag}.${publicDomain}`) && hostnames.includes(`${tag}-api.${publicDomain}`));
  const infra = new CloudInfraProvider(client, { namespace: tag, dockerWorkspaceId: workspaceId, adminProxy });
  for (const hostname of hostnames) await infra.removeRoute(hostname);
  for (const slug of [...pages]) {
    const absent = await admin.pages.get(slug).then(() => false, error => error.status === 404);
    check("project route anchor removed", absent);
    pages.delete(slug);
  }
  check("one workspace for the whole stack", (await client.workspaces.list()).workspaces.length === 1);
} catch (error) {
  log("smoke failed", { message: error instanceof Error ? error.message : "Unknown error", code: (error as { code?: string }).code });
  process.exitCode = 1;
} finally {
  await runtime?.dispose().catch(() => {});
  for (const slug of pages) {
    try {
      const page = (await admin.pages.get(slug)).page;
      if (page.namespace !== tag || page.source_workspace_id !== workspaceId) throw new Error("Unexpected smoke page owner");
      await admin.pages.delete(slug);
      pages.delete(slug);
    } catch (error) {
      if ((error as { status?: number }).status === 404) pages.delete(slug);
      else { log("page cleanup failed", { slug }); process.exitCode = 1; }
    }
  }
  if (workspaceId) {
    try { await deleteCloudWorkspace(admin.workspace(workspaceId)); workspaceId = undefined; }
    catch (error) {
      if ((error as { status?: number }).status === 404) workspaceId = undefined;
      else { log("workspace cleanup needs retry", { manifest }); process.exitCode = 1; }
    }
  }
  if (namespaceId && !workspaceId && pages.size === 0) {
    try { await admin.namespaces.delete(namespaceId); namespaceId = undefined; }
    catch { log("namespace cleanup needs retry", { manifest }); process.exitCode = 1; }
  }
  await save();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  log("finished", { passed: report.filter(item => item.passed).length, cleanupComplete: !namespaceId && !workspaceId && pages.size === 0, report: join(directory, "report.json") });
  // Retain the small report/manifest for diagnosis; source carries no secrets.
  await rm(join(directory, "source"), { recursive: true, force: true });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
