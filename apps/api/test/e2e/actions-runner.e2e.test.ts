import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionsWorker,
  CloudWorkspaceExecutor,
  DockerRuntime,
  LocalExecutor,
  createExecutor,
  ensureDockerEmulation,
  probeActionCapabilities,
  type CommandExecutor,
} from "@repo/adapters";
import { shellQuote as q, type ActionWorkerRequest, type ActionWorkerEvent } from "@repo/core";
import { createDatabase, createRepositories, schema } from "@repo/db/factory";
import {
  ActionController,
  type ActionControllerPorts,
} from "@repo/platform/engine/modules/actions/controller";
import { parseActionWorkflow } from "@repo/platform/engine/modules/actions/workflow";
import {
  ensureRunnerAssets,
  runnerDirectory,
} from "../../../../packages/actions-runner/assets.mjs";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { availablePort, sshReady } from "../helpers/migration-host";
import { workspaceRuntime } from "../helpers/workspace-runtime";

const tag = randomUUID().slice(0, 8);
const hostImage = `openship-actions-host:${tag}`;
const local = new LocalExecutor();
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/migration-target");

describeDockerE2E("Actions on an isolated SSH Docker host and managed execution adapter", () => {
  let parent: DockerRuntime;
  let hostId: string;
  let temp: string;
  let ssh: CommandExecutor;
  let cloud: CloudWorkspaceExecutor;
  let worker: ActionsWorker;
  let installed: { root: string; binary: string };

  beforeAll(async () => {
    await requireDocker();
    ensureRunnerAssets();
    parent = await DockerRuntime.create({ transport: "socket" });
    temp = await mkdtemp(join(tmpdir(), "openship-actions-e2e-"));
    const key = join(temp, "identity");
    await local.exec(`ssh-keygen -q -t ed25519 -N '' -f ${q(key)}`);
    await local.exec(`docker build -q -t ${q(hostImage)} ${q(fixture)}`, { timeout: 300_000 });
    const port = await availablePort();
    const vm = await parent.docker.createContainer({
      Image: hostImage,
      name: `openship-actions-test-${tag}`,
      Labels: { "openship.test": tag },
      // Docker's wrapper delegates cgroup v2 controllers before the inner
      // daemon starts, so CPU/memory enforcement is exercised on this host.
      Entrypoint: ["/usr/local/bin/dind", "/usr/local/bin/migration-target"],
      HostConfig: {
        Privileged: true,
        PortBindings: { "22/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
      },
      ExposedPorts: { "22/tcp": {} },
    });
    hostId = vm.id;
    await local.exec(`docker cp ${q(key + ".pub")} ${q(hostId + ":/root/.ssh/authorized_keys")}`);
    await vm.start();
    for (let i = 0; !(await sshReady(port)); i++) {
      if (i > 100) throw new Error("Actions SSH host did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    ssh = createExecutor({
      host: "127.0.0.1",
      port,
      username: "root",
      privateKey: await readFile(key, "utf8"),
      readyTimeoutMs: 5000,
    });
    await ssh.exec("apk add --no-cache bash git nodejs", { timeout: 180_000 });
    await ssh.writeFile(
      "/tmp/actions-image/Dockerfile",
      "FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*\n",
    );
    await ssh.exec(
      "docker build -q -t openship-actions-fixture /tmp/actions-image && docker pull nginx:stable-alpine && docker pull busybox:1.37",
      { timeout: 300_000 },
    );
    await ssh.exec(
      "docker volume create existing-app-data && docker run -d --name existing-app -v existing-app-data:/data busybox:1.37 sh -c 'echo keep > /data/value; sleep 600'",
    );
    worker = new ActionsWorker(ssh, join(runnerDirectory, "dist"));
    const capabilities = await probeActionCapabilities(ssh);
    expect(capabilities).toMatchObject({ os: "linux", docker: true, git: true, node: true });
    installed = await worker.prepare(capabilities);
    cloud = new CloudWorkspaceExecutor(
      async () => workspaceRuntime(ssh) as never,
      `test-actions-${tag}`,
    );
  }, 600_000);

  afterAll(async () => {
    await cloud?.dispose();
    await ssh?.dispose();
    if (hostId) await parent.docker.getContainer(hostId).remove({ force: true, v: true });
    await parent?.docker
      .getImage(hostImage)
      .remove({ force: true })
      .catch(() => {});
    await parent?.dispose();
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  function request(source: string, native = false) {
    const id = `job-${randomUUID()}`;
    const directory = `${installed.root}/jobs/${id}`;
    const input: ActionWorkerRequest = {
      version: 1,
      id,
      workflow: source,
      workflowPath: ".github/workflows/ci.yml",
      job: "test",
      directory: `${directory}/work`,
      eventName: "workflow_dispatch",
      event: { inputs: {} },
      actor: "tester",
      defaultBranch: "main",
      matrix: {},
      strategy: {},
      needs: {},
      environment: {
        GITHUB_REPOSITORY: "example/app",
        GITHUB_REPOSITORY_OWNER: "example",
        GITHUB_REF: "refs/heads/main",
        SHA_REF: "a".repeat(40),
      },
      secrets: { TOKEN: "secret-never-visible-in-journal" },
      variables: {},
      inputs: {},
      platforms: { "self-hosted": native ? "-self-hosted" : "openship-actions-fixture" },
      timeoutSeconds: 180,
      containerCpu: 0.5,
      containerMemoryMb: 512,
      dockerSocket: false,
    };
    return { input, directory };
  }

  async function finish(
    active: ActionsWorker,
    directory: string,
    collected: ActionWorkerEvent[] = [],
  ) {
    let cursor = 0;
    const deadline = Date.now() + 200_000;
    while (Date.now() < deadline) {
      const snapshot = await active.inspect(installed.binary, directory, cursor);
      collected.push(...snapshot.events);
      cursor = snapshot.events.at(-1)?.sequence ?? cursor;
      if (snapshot.state === "finished" && !snapshot.hasMore) return snapshot.result!;
      if (snapshot.state === "interrupted")
        throw new Error(
          `Worker interrupted: ${collected.map((event) => event.message).join("\n")}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      `Actions attempt did not finish: ${collected.map((event) => event.message).join("\n")}`,
    );
  }

  async function assertAppUnchanged() {
    expect(
      (await ssh.exec("docker inspect existing-app --format '{{.State.Running}}'")).trim(),
    ).toBe("true");
    expect((await ssh.exec("docker exec existing-app cat /data/value")).trim()).toBe("keep");
  }

  // binfmt registration belongs to the Docker host's kernel. Only opt in on an
  // isolated test VM (including the disposable CI runner), never a developer's
  // shared Docker daemon merely because it is reachable.
  it.skipIf(process.env.ACTIONS_E2E_ENABLE_EMULATION !== "1")(
    "runs x64 and ARM64 images through SSH and managed execution with truthful runner contexts",
    async () => {
      const capabilities = await probeActionCapabilities(ssh);
      const platforms = await ensureDockerEmulation(ssh, capabilities.dockerArchitecture!);
      expect(platforms).toEqual(expect.arrayContaining(["linux/amd64", "linux/arm64"]));
      expect((await probeActionCapabilities(cloud)).dockerPlatforms).toEqual(
        expect.arrayContaining(platforms),
      );
      for (const [platform, architecture, uname, active] of [
        ["linux/amd64", "X64", "x86_64", worker],
        [
          "linux/arm64",
          "ARM64",
          "aarch64",
          new ActionsWorker(cloud, join(runnerDirectory, "dist")),
        ],
      ] as const) {
        const { input, directory } = request(`on: workflow_dispatch
jobs:
  test:
    runs-on: [self-hosted, ${architecture.toLowerCase()}]
    container: busybox:1.37
    outputs:
      architecture: \${{ steps.cpu.outputs.architecture }}
    steps:
      - id: cpu
        shell: sh
        run: |
          test "$(uname -m)" = '${uname}'
          test "$RUNNER_ARCH" = '${architecture}'
          test '\${{ runner.arch }}' = '${architecture}'
          test ! -S /var/run/docker.sock
          echo "architecture=$RUNNER_ARCH" >> "$GITHUB_OUTPUT"
`);
        input.containerPlatform = platform;
        await active.start(installed.binary, directory, input);
        const events: ActionWorkerEvent[] = [];
        expect(
          await finish(active, directory, events),
          events.map((event) => event.message).join("\n"),
        ).toMatchObject({
          conclusion: "success",
          outputs: { architecture },
        });
        await active.clean(installed.binary, directory);
        await assertAppUnchanged();
      }
    },
    240_000,
  );

  it("runs a container job with a service, composite action and JavaScript action; cleans only its resources", async () => {
    const { input, directory } = request(`on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    container: openship-actions-fixture
    services:
      site:
        image: nginx:stable-alpine
    outputs:
      value: \${{ steps.answer.outputs.value }}
    steps:
      - name: Check service and isolation
        env:
          TOKEN: \${{ secrets.TOKEN }}
        run: |
          test ! -S /var/run/docker.sock
          curl --fail --retry 10 --retry-delay 1 http://site
          echo "$TOKEN"
      - name: Create local actions in the checked-out workspace
        run: |
          mkdir -p .github/actions/composite .github/actions/javascript
          printf '%s' 'bmFtZTogQ29tcG9zaXRlCmRlc2NyaXB0aW9uOiBUZXN0CnJ1bnM6CiAgdXNpbmc6IGNvbXBvc2l0ZQogIHN0ZXBzOgogICAgLSBzaGVsbDogYmFzaAogICAgICBydW46IGVjaG8gQ09NUE9TSVRFPXJlYWR5ID4+ICIkR0lUSFVCX0VOViIK' | base64 -d > .github/actions/composite/action.yml
          printf '%s' 'bmFtZTogSmF2YVNjcmlwdApkZXNjcmlwdGlvbjogVGVzdApydW5zOgogIHVzaW5nOiBub2RlMjAKICBtYWluOiBpbmRleC5qcwo=' | base64 -d > .github/actions/javascript/action.yml
          printf '%s' 'aWYgKHByb2Nlc3MuZW52LkNPTVBPU0lURSAhPT0gJ3JlYWR5JykgdGhyb3cgbmV3IEVycm9yKCdNaXNzaW5nIGNvbXBvc2l0ZSBvdXRwdXQnKTsgY29uc29sZS5sb2coJ2phdmFzY3JpcHQgYWN0aW9uIHJhbicpOwo=' | base64 -d > .github/actions/javascript/index.js
      - uses: ./.github/actions/composite
      - uses: ./.github/actions/javascript
      - id: answer
        run: |
          test "$COMPOSITE" = ready
          echo value=42 >> "$GITHUB_OUTPUT"
`);
    await worker.start(installed.binary, directory, input);
    const events: ActionWorkerEvent[] = [];
    const result = await finish(worker, directory, events);
    expect(result, events.map((event) => event.message).join("\n")).toMatchObject({
      conclusion: "success",
      outputs: { value: "42" },
    });
    expect(events.some((event) => event.message?.includes("javascript action ran"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(input.secrets.TOKEN);
    expect(await ssh.exists(`${directory}/request.json`)).toBe(false);
    await worker.clean(installed.binary, directory);
    for (const resource of ["ps -aq", "volume ls -q", "network ls -q"])
      expect(
        await ssh.exec(
          `docker ${resource} --filter ${q("label=io.openship.actions.job=" + input.id)}`,
        ),
      ).toBe("");
    await assertAppUnchanged();
  });

  it("uses the same worker through Cloud execution, enforces limits and waits for cancellation", async () => {
    const managed = new ActionsWorker(cloud, join(runnerDirectory, "dist"));
    expect(await managed.prepare(await probeActionCapabilities(cloud))).toEqual(installed);
    const { input, directory } = request(
      "on: workflow_dispatch\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: sleep 90\n",
    );
    await managed.start(installed.binary, directory, input);
    let container = "";
    for (let i = 0; i < 100; i++) {
      container = (
        await ssh.exec(`docker ps -q --filter ${q("label=io.openship.actions.job=" + input.id)}`)
      ).trim();
      if (container) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(container).toMatch(/^[a-f0-9]+$/);
    const limits = JSON.parse(
      await ssh.exec(`docker inspect ${q(container)} --format '{{json .HostConfig}}'`),
    );
    expect(limits.NanoCpus).toBe(500_000_000);
    expect(limits.Memory).toBe(512 * 1024 * 1024);
    await expect(managed.clean(installed.binary, directory)).rejects.toThrow();
    await managed.cancel(installed.binary, directory);
    expect((await finish(managed, directory)).conclusion).toBe("cancelled");
    await managed.clean(installed.binary, directory);
    await assertAppUnchanged();
  });

  it("connects host-style jobs to their published service ports", async () => {
    const { input, directory } = request(`on: workflow_dispatch
jobs:
  test:
    runs-on: self-hosted
    services:
      site:
        image: nginx:stable-alpine
        ports: [80]
    steps:
      - run: curl --fail --retry 5 --retry-connrefused http://127.0.0.1:\${{ job.services.site.ports[80] }}
`);
    await worker.start(installed.binary, directory, input);
    const events: ActionWorkerEvent[] = [];
    expect(
      await finish(worker, directory, events),
      events.map((event) => event.message).join("\n"),
    ).toMatchObject({ conclusion: "success" });
    await worker.clean(installed.binary, directory);
    await assertAppUnchanged();
  });

  it("executes a native Linux job without creating a Docker job or replaying a completed attempt", async () => {
    const { input, directory } = request(
      "on: workflow_dispatch\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo once >> /tmp/native-actions-side-effect\n",
      true,
    );
    await worker.start(installed.binary, directory, input);
    expect((await finish(worker, directory)).conclusion).toBe("success");
    await worker.start(installed.binary, directory, input);
    expect((await ssh.readFile("/tmp/native-actions-side-effect")).trim()).toBe("once");
    expect(
      await ssh.exec(`docker ps -aq --filter ${q("label=io.openship.actions.job=" + input.id)}`),
    ).toBe("");
    await worker.clean(installed.binary, directory);
    await assertAppUnchanged();
  });

  it.each(["ssh", "managed"] as const)(
    "resumes the durable controller over %s through matrix jobs, outputs and final cleanup",
    async (transport) => {
      const database = await createDatabase({ driver: "pglite", dataDir: "memory://" });
      const org = `org-${randomUUID()}`;
      const server = `server-${randomUUID()}`;
      const repo = createRepositories(database.db, {
        encrypt: (value) => value,
        decrypt: (value) => value,
      }).actions;
      const activeWorker =
        transport === "ssh" ? worker : new ActionsWorker(cloud, join(runnerDirectory, "dist"));
      const source = `name: Durable CI
on: workflow_dispatch
jobs:
  build:
    runs-on: [self-hosted, linux]
    timeout-minutes: 2
    strategy:
      matrix:
        version: [20, 22]
    outputs:
      result: \${{ steps.build.outputs.result }}
    steps:
      - id: build
        env:
          TOKEN: \${{ secrets.CI_TOKEN }}
        run: |
          echo "Building \${{ matrix.version }}"
          echo "$TOKEN"
          echo result=ready >> "$GITHUB_OUTPUT"
  verify:
    needs: build
    runs-on: [self-hosted, linux]
    timeout-minutes: 2
    steps:
      - id: verify
        env:
          RESULT: \${{ needs.build.outputs.result }}
        run: test "$RESULT" = ready
`;
      try {
        await database.db
          .insert(schema.organization)
          .values({ id: org, name: "Actions end-to-end" });
        await database.db.insert(schema.servers).values({
          id: server,
          organizationId: org,
          sshHost: "isolated-fixture",
          sshUser: "root",
        });
        const runner = await repo.saveRunner({
          id: `runner-${randomUUID()}`,
          organizationId: org,
          serverId: server,
          name: "Isolated build host",
          config: {
            mode: "container",
            image: "openship-actions-fixture",
            cpu: 0.5,
            memoryMb: 512,
            maxParallel: 1,
            labels: [],
            allowDockerSocket: false,
          },
          capabilities: await probeActionCapabilities(ssh),
          enabled: true,
        });
        const plan = await parseActionWorkflow(source);
        const authority = {
          version: 1 as const,
          userId: "e2e-actor",
          organizationId: org,
          token: null,
          restrictions: null,
        };
        const workflow = await repo.saveWorkflow({
          id: `workflow-${randomUUID()}`,
          organizationId: org,
          owner: "example",
          repo: "app",
          ref: "main",
          name: "Durable CI",
          path: ".github/workflows/ci.yml",
          source,
          definition: plan,
          runnerIds: [runner.id],
          authority,
        });
        const run = await repo.createRun({
          id: `run-${randomUUID()}`,
          organizationId: org,
          workflowId: workflow.id,
          idempotencyKey: "e2e-dispatch",
          source,
          plan,
          revision: "a".repeat(40),
          ref: "refs/heads/main",
          eventName: "workflow_dispatch",
          event: {},
          actor: "e2e-actor",
          authority,
          configuration: {
            owner: "example",
            repo: "app",
            path: workflow.path,
            defaultBranch: "main",
            runnerIds: [runner.id],
            secrets: {},
            variables: {},
          },
        });
        const errors: unknown[] = [];
        const ports: ActionControllerPorts = {
          repo,
          // Authentication, GitHub and provider lifecycle are covered by their
          // boundary tests. This journey uses the real scheduler, DB and worker.
          authorize: async () => {},
          secrets: async () => ({ CI_TOKEN: "durable-secret-never-persisted-in-logs" }),
          open: async (_run, job) => ({
            worker: activeWorker,
            binary: installed.binary,
            directory: `${installed.root}/jobs/${job.id}`,
            release: async () => {},
          }),
          cleanup: async () => true,
          check: async (_run, job) => ({ id: `check-${job.id}`, error: null }),
          reportError: (error) => errors.push(error),
        };
        let controller = new ActionController(ports);
        await controller.reconcile(org, run.id);
        expect((await repo.jobs(org, run.id)).filter((job) => job.workerStartedAt)).toHaveLength(1);
        controller = new ActionController(ports); // No in-memory state survives.
        const deadline = Date.now() + 120_000;
        while (!(await repo.run(org, run.id))?.settledAt && Date.now() < deadline) {
          await controller.reconcile(org, run.id);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const jobs = await repo.jobs(org, run.id);
        expect(errors).toEqual([]);
        expect(await repo.run(org, run.id), JSON.stringify(jobs)).toMatchObject({
          status: "success",
          settledAt: expect.any(Date),
        });
        expect(jobs).toHaveLength(3);
        expect(
          jobs
            .filter((job) => job.jobKey === "build")
            .map((job) => job.spec?.matrix.version)
            .sort(),
        ).toEqual([20, 22]);
        for (const job of jobs) {
          const saved = await repo.events(org, job.id);
          expect(saved.filter((row) => row.event.type === "started")).toHaveLength(1);
          expect(JSON.stringify(saved)).not.toContain("durable-secret-never-persisted-in-logs");
          expect(job.cleanedAt).toBeInstanceOf(Date);
          expect(await ssh.exists(job.directory!)).toBe(false);
          expect(job.result?.steps[job.jobKey]?.conclusion).toBe("success");
        }
        expect(await repo.runnerBusy(org, runner.id)).toBe(false);
        await assertAppUnchanged();
      } finally {
        await database.close();
      }
    },
  );
});
