/** Opt-in LIVE GitHub → real HTTP/SDK → draft PR → merge → Docker/runtime test.
 * No GitHub transport, token resolver, auth, publisher or runtime is mocked.
 * Run only against a private openship-runtime-source-verification-* scratch repo.
 * The default branch is never modified; each run uses and removes its own branches. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { BuildLogger, DockerRuntime } from "@repo/adapters";
import { OpenshipClient } from "@repo/sdk/client";
import { repos } from "@repo/db";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { ghFetch } from "@repo/platform/engine/modules/github/github.http";
import { buildConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";
import { createDockerfileBuildConfig } from "@repo/platform/engine/modules/deployments/build-config";
import { parseComposeFile } from "@repo/platform/engine/lib/compose-parser";
import { runtimeSourceTestApp, sourceClients } from "../helpers/runtime-source";
import { seedOwner } from "../modules/jobs/_harness";
import { seedProject, seedDeployment } from "../helpers/seed";
import { requireDocker } from "../helpers/docker-e2e";

const repo = process.env.OPENSHIP_LIVE_SOURCE_REPO;
if (!repo || !/^[\w-]+\/openship-runtime-source-verification-[\w-]+$/.test(repo))
  throw new Error(
    "Set OPENSHIP_LIVE_SOURCE_REPO to a private owner/openship-runtime-source-verification-* scratch repository.",
  );
const [ownerName, repoName] = repo.split("/");
const branch = `verification-${randomUUID()}`;
const OLD = "node:22.23.3-alpine",
  PATCHED = "node:22.23.4-alpine";
let token = "",
  directory = "",
  defaultSha = "",
  defaultBranch = "";
let runtime: DockerRuntime;
let http: ReturnType<typeof serve>;
let client: OpenshipClient;
let actor: Awaited<ReturnType<typeof seedOwner>>;
let project: Awaited<ReturnType<typeof seedProject>>;
const containers = new Set<string>(),
  images = new Set<string>(),
  networks = new Set<string>(),
  volumes = new Set<string>();
const branches = new Set<string>(),
  prs = new Set<number>();
const api = <T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  params?: Record<string, unknown>,
) => ghFetch<T>(token, { url: `https://api.github.com/repos/${repo}${path}`, method, params });

beforeAll(async () => {
  await requireDocker();
  token = execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const repository = await api<{ private: boolean; archived: boolean; default_branch: string }>("");
  if (!repository.private || repository.archived)
    throw new Error("Use an active private verification repository.");
  defaultBranch = repository.default_branch;
  defaultSha = (await api<{ object: { sha: string } }>(`/git/ref/heads/${defaultBranch}`)).object
    .sha;
  const base = await api<{ tree: { sha: string } }>(`/git/commits/${defaultSha}`);
  const files = {
    Dockerfile: `# Keep this comment\nFROM ${OLD}\nCOPY server.cjs /server.cjs\nCMD ["node", "/server.cjs"]\n`,
    "server.cjs":
      'require("http").createServer((q,s)=>s.end(process.version+":"+process.env.KEEP)).listen(8080,"127.0.0.1");\n',
    "compose.yml": `# Keep the other service untouched\nservices:\n  api:\n    image: '${OLD}' # version\n    command: [node, -e, 'setInterval(() => {}, 1000)']\n    environment: {KEEP: unchanged}\n    volumes: [data:/data]\n  db:\n    image: postgres:16-alpine\nvolumes:\n  data: {}\n`,
  };
  const tree = await api<{ sha: string }>("/git/trees", "POST", {
    base_tree: base.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({
      path,
      content,
      type: "blob",
      mode: "100644",
    })),
  });
  const commit = await api<{ sha: string }>("/git/commits", "POST", {
    message: "Set up isolated source-update verification",
    tree: tree.sha,
    parents: [defaultSha],
  });
  await api("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  branches.add(branch);
  actor = await seedOwner();
  // Real encrypted personal connection, scoped to the isolated in-memory test user.
  await repos.settings.upsert({
    id: randomUUID(),
    userId: actor.userId,
    cloneTokenEncrypted: encrypt(token),
    cloneTokenAsDefault: true,
  });
  project = await seedProject(actor.orgId, {
    gitOwner: ownerName,
    gitRepo: repoName,
    gitBranch: branch,
    gitProvider: "github",
    framework: "docker",
    buildKind: "dockerfile",
    hasBuild: true,
    hasServer: true,
  });
  http = serve({ fetch: runtimeSourceTestApp.fetch, hostname: "127.0.0.1", port: 0 });
  if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  client = new OpenshipClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: actor.token,
    organizationId: actor.orgId,
  });
  directory = await mkdtemp(join(tmpdir(), "openship-live-source-"));
  await writeFile(join(directory, "server.cjs"), files["server.cjs"]);
  runtime = await DockerRuntime.create({ transport: "socket" });
  for (const image of [OLD, PATCHED]) await runtime.pullImage(image);
});

afterAll(async () => {
  for (const number of prs) {
    const pr = await api<{ state: string }>(`/pulls/${number}`);
    if (pr.state === "open") await api(`/pulls/${number}`, "PATCH", { state: "closed" });
  }
  for (const name of branches) await api(`/git/refs/heads/${name}`, "DELETE");
  if (defaultSha)
    expect(
      (await api<{ object: { sha: string } }>(`/git/ref/heads/${defaultBranch}`)).object.sha,
    ).toBe(defaultSha);
  for (const id of containers) await runtime.destroy(id);
  for (const image of images) await runtime.removeImage(image);
  for (const id of networks) await runtime.docker.getNetwork(id).remove();
  for (const name of volumes) await runtime.docker.getVolume(name).remove();
  await runtime?.dispose();
  if (http)
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function proposeAndMerge(path: string, format: "dockerfile" | "compose") {
  const source = await client.updates.runtimeSource(project.id, { path, format });
  expect(source.publishAccess).toBe("available");
  const edit = {
    path,
    format,
    baseSha: source.baseSha,
    referenceId: source.references[0]!.id,
    image: PATCHED,
  };
  const preview = await client.updates.previewRuntimeSource(project.id, edit);
  expect(preview.after).toBe(preview.before.replace(OLD, PATCHED));
  const published = await client.updates.publishRuntimeSource(project.id, {
    ...edit,
    reviewId: preview.reviewId,
    requestId: randomUUID(),
  });
  branches.add(published.branch);
  const number = Number(published.pullRequestUrl!.split("/").at(-1));
  prs.add(number);
  const pr = await api<{
    draft: boolean;
    head: { sha: string };
    base: { ref: string };
    user: { login: string };
  }>(`/pulls/${number}`);
  expect(pr.draft).toBe(true);
  expect(pr.base.ref).toBe(branch);
  expect(pr.head.sha).toBe(published.commitSha);
  expect((await api<{ object: { sha: string } }>(`/git/ref/heads/${branch}`)).object.sha).toBe(
    source.baseSha,
  );
  // Explicit test-only approval: product code never marks ready, merges or deploys.
  execFileSync("gh", ["pr", "ready", published.pullRequestUrl!], { stdio: "pipe" });
  expect(
    await api(`/pulls/${number}/merge`, "PUT", {
      sha: published.commitSha,
      merge_method: "squash",
    }),
  ).toMatchObject({ merged: true });
  const saved = await api<{ content: string }>(`/contents/${path}?ref=${branch}`);
  expect(Buffer.from(saved.content, "base64").toString()).toBe(preview.after);
  expect((await repos.project.findById(project.id))!.activeDeploymentId).toBeNull();
  console.info("[live-source] draft PR created through Openship; reviewed and merged by test", {
    url: published.pullRequestUrl,
    author: pr.user.login,
    file: path,
  });
  return preview.after;
}

it("recovers an expired GitHub connection and enforces real workspace permissions", async () => {
  await repos.settings.update(actor.userId, {
    cloneTokenEncrypted: encrypt("invalid-live-verification-token"),
  });
  await expect(
    client.updates.runtimeSource(project.id, { path: "Dockerfile", format: "dockerfile" }),
  ).rejects.toMatchObject({ code: "REPOSITORY_GITHUB_ACCESS_REQUIRED" });
  await repos.settings.update(actor.userId, { cloneTokenEncrypted: encrypt(token) });
  const source = await client.updates.runtimeSource(project.id, {
    path: "Dockerfile",
    format: "dockerfile",
  });
  expect(source.publishAccess).toBe("available");
  const readOnly = await sourceClients(actor, actor.orgId, {
    credential: { organizationId: actor.orgId, readOnly: true },
  });
  expect(
    (
      await readOnly.native.updates.runtimeSource(project.id, {
        path: "Dockerfile",
        format: "dockerfile",
      })
    ).publishAccess,
  ).toBe("workspace_access_required");
});

it("creates a real Dockerfile PR and keeps the patched runtime on the next rebuild", async () => {
  const content = await proposeAndMerge("Dockerfile", "dockerfile");
  await writeFile(join(directory, "Dockerfile"), content);
  const buildProject = { ...project, gitProvider: "local", localPath: directory };
  for (let attempt = 0; attempt < 2; attempt++) {
    const dep = await seedDeployment(project, { status: "building", branch });
    const built = await runtime.build(
      createDockerfileBuildConfig({
        project: buildProject,
        dep,
        snapshot: buildConfigSnapshot(buildProject),
        sessionId: dep.id,
        envVars: {},
        resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
      }),
      new BuildLogger(),
    );
    expect(built.status, built.errorMessage).toBe("deploying");
    images.add(built.imageRef!);
    const running = await runtime.deploy({
      deploymentId: dep.id,
      projectId: project.id,
      buildSessionId: dep.id,
      imageRef: built.imageRef!,
      environment: "production",
      port: 8080,
      portless: true,
      runtimeName: `live-source-${dep.id}`,
      envVars: { KEEP: "unchanged" },
      resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
      restartPolicy: "no",
    });
    containers.add(running.containerId!);
    const exec = await runtime.inContainerExecutor(running.containerId!);
    await expect
      .poll(() => exec.exec("wget -qO- http://127.0.0.1:8080"), { timeout: 15000 })
      .toBe("v22.23.4:unchanged");
    const inspect = await runtime.docker.getContainer(running.containerId!).inspect();
    for (const [name, network] of Object.entries(inspect.NetworkSettings.Networks ?? {}))
      if (!["bridge", "host", "none"].includes(name)) networks.add(network.NetworkID);
    expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((value) => !value)).toBe(true);
    await repos.deployment.updateStatus(dep.id, "ready", { imageRef: built.imageRef! });
  }
  console.info(
    "[live-source] real merged source → Docker build → HTTP v22.23.4:unchanged → rebuild v22.23.4:unchanged",
  );
});

it("creates a real Compose PR and preserves volume data and environment across replacement", async () => {
  const original = await api<{ content: string }>(`/contents/compose.yml?ref=${branch}`);
  const networkId = await runtime.ensureNetwork(project.slug);
  networks.add(networkId);
  const start = async (content: string) => {
    const service = parseComposeFile(content).services.find((s) => s.name === "api")!;
    const running = await runtime.deployService({
      deploymentId: randomUUID(),
      projectId: project.id,
      slug: project.slug,
      networkId,
      serviceName: service.name,
      image: service.image!,
      environment: service.environment,
      commandArgv: service.commandArgv,
      ports: [],
      volumes: service.volumes,
      namespaceVolumes: true,
      expose: false,
    });
    containers.add(running.containerId);
    const inspect = await runtime.docker.getContainer(running.containerId).inspect();
    for (const mount of inspect.Mounts ?? [])
      if (mount.Type === "volume" && mount.Name) volumes.add(mount.Name);
    expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((value) => !value)).toBe(true);
    return runtime.inContainerExecutor(running.containerId);
  };
  const old = await start(Buffer.from(original.content, "base64").toString());
  await old.exec("printf retained-data > /data/check");
  const after = await start(await proposeAndMerge("compose.yml", "compose"));
  expect((await after.exec("node --version")).trim()).toBe("v22.23.4");
  expect(await after.exec("cat /data/check")).toBe("retained-data");
  expect((await after.exec("printenv KEEP")).trim()).toBe("unchanged");
  console.info(
    "[live-source] real merged Compose source → service replacement → v22.23.4; retained volume and environment",
  );
});
