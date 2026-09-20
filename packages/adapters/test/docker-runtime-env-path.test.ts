import { describe, expect, it } from "vitest";

import { DockerRuntime } from "../src/runtime/docker";
import { droppedRuntimeEnvMessage } from "../src/runtime/runtime-env";
import type { DeployConfig, LogEntry } from "../src/types";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "../src/runtime/types";

/**
 * A project env var named PATH must never reach a container's `Env` (openship#623).
 *
 * Docker performs NO expansion on `Env`: the value is an absolute literal that
 * REPLACES the image's own `ENV PATH`, including the `node_modules/.bin` entry the
 * generated Dockerfile adds so a dependency-binary start command (`next start`)
 * resolves. The build stays green and the container exits 127 at RUN time, with
 * nothing in the log naming PATH. Nothing upstream rejects the key either — the
 * env-merge endpoints bound only count and length.
 *
 * Pinned at the CREATE PAYLOAD rather than at the filter, for the reason
 * docker-entrypoint.test.ts / docker-namespaces.test.ts give: the only way to know
 * what Docker was told is to look at what was passed. Both container-Env sites are
 * driven here — the single-app deploy and the compose service — because the filter
 * being correct says nothing about a site that forgot to call it.
 */

/** Insertion-ordered on purpose: `Env` order decides which duplicate key wins. */
const PROJECT_ENV: Record<string, string> = {
  APP_NAME: "demo",
  // The poison. An absolute literal with no `$PATH` to inherit from.
  PATH: "/usr/local/bin:/usr/bin",
  // Near-misses: the filter is an exact-key match, not a substring one.
  MY_PATH: "/opt/mine",
  PATHOLOGY: "chronic",
  // Docker env is CASE-SENSITIVE, and `path` is a distinct variable that no
  // POSIX loader reads for lookup — dropping it would delete operator data.
  path: "/lower/case",
  NODE_OPTIONS: "--max-old-space-size=512",
};

/** PROJECT_ENV minus PATH, in declaration order. */
const SURVIVORS = [
  "APP_NAME=demo",
  "MY_PATH=/opt/mine",
  "PATHOLOGY=chronic",
  "path=/lower/case",
  "NODE_OPTIONS=--max-old-space-size=512",
];

/** A daemon that records the create payload and reports a bare running container. */
function recordingDaemon() {
  const creates: Array<Record<string, any>> = [];
  const docker = {
    getContainer: () => ({
      remove: async () => undefined,
      inspect: async () => ({ Config: {}, State: {}, NetworkSettings: { Networks: {} } }),
      stop: async () => undefined,
    }),
    createContainer: async (args: Record<string, any>) => {
      creates.push(args);
      return {
        id: "c".repeat(64),
        start: async () => undefined,
        remove: async () => undefined,
        inspect: async () => ({ NetworkSettings: { Networks: {} }, Config: {} }),
      };
    },
    getImage: () => ({ inspect: async () => ({ RepoDigests: [] }) }),
  };
  return { docker, creates };
}

async function runtimeWith(docker: unknown): Promise<DockerRuntime> {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  return runtime;
}

/** What a deploy told Docker, plus everything it told the operator. */
type Run = { env: string[]; logs: LogEntry[] };

/** Warn-level lines only — the channel the drop notice has to arrive on. */
const warns = (run: Run): LogEntry[] => run.logs.filter((l) => l.level === "warn");

/** Single-app deploy path (DockerRuntime.deploy). */
async function deployRun(envVars: Record<string, string>): Promise<Run> {
  const { docker, creates } = recordingDaemon();
  const runtime = await runtimeWith(docker);
  const logs: LogEntry[] = [];
  await runtime.deploy(
    {
      deploymentId: "dep-1",
      projectId: "proj-1",
      buildSessionId: "sess-1",
      imageRef: "openship/app:sess-1",
      environment: "production",
      port: 8000,
      envVars,
      resources: { cpuCores: 1, memoryMb: 512 },
      runtimeName: "demo",
      slug: "demo",
    } as DeployConfig,
    (entry) => logs.push(entry),
  );
  return { env: creates[0]!.Env as string[], logs };
}

/** Compose service path (DockerRuntime.deployServiceWorkload). */
async function serviceRun(environment: Record<string, string>): Promise<Run> {
  const { docker, creates } = recordingDaemon();
  const runtime = await runtimeWith(docker);
  const group: MultiServiceGroupHandle = { id: "net-openship-demo" };
  const logs: LogEntry[] = [];
  await runtime.deployServiceWorkload(
    group,
    {
      deploymentId: "dep-1",
      projectId: "proj-1",
      slug: "demo",
      serviceName: "web",
      // `openship/` prefix → locally built, so the pull path is skipped.
      image: "openship/demo-web:sess-1",
      ports: [],
      environment,
      volumes: [],
      namespaceVolumes: true,
    } as MultiServiceDeployConfig,
    (entry) => logs.push(entry),
  );
  return { env: creates[0]!.Env as string[], logs };
}

const deployEnv = async (envVars: Record<string, string>): Promise<string[]> =>
  (await deployRun(envVars)).env;

const serviceEnv = async (environment: Record<string, string>): Promise<string[]> =>
  (await serviceRun(environment)).env;

describe("DockerRuntime.deploy — project PATH never reaches container Env (#623)", () => {
  it("#801: passes secret-looking runtime values to Docker unchanged", async () => {
    const env = await deployEnv({
      AUTH_SECRET: "runtime-secret",
      PG_HURRICANE_PASSWORD: "p@ss=word with spaces",
      PUBLIC_SETTING: "enabled",
    });
    expect(env).toContain("AUTH_SECRET=runtime-secret");
    expect(env).toContain("PG_HURRICANE_PASSWORD=p@ss=word with spaces");
    expect(env).toContain("PUBLIC_SETTING=enabled");
  });

  it("drops PATH and keeps every other key in declaration order", async () => {
    const env = await deployEnv(PROJECT_ENV);
    // The runtime's own two come first, then the project's, unchanged in order.
    expect(env).toEqual(["PORT=8000", "NODE_ENV=production", ...SURVIVORS]);
  });

  it("emits no PATH assignment at all, so the image's ENV PATH survives", async () => {
    const env = await deployEnv(PROJECT_ENV);
    expect(env.some((e) => e.startsWith("PATH="))).toBe(false);
  });

  it("keeps keys that merely CONTAIN 'PATH', and the lowercase `path`", async () => {
    const env = await deployEnv(PROJECT_ENV);
    expect(env).toContain("MY_PATH=/opt/mine");
    expect(env).toContain("PATHOLOGY=chronic");
    expect(env).toContain("path=/lower/case");
  });

  it("a project whose ONLY var is PATH contributes nothing", async () => {
    expect(await deployEnv({ PATH: "/usr/bin" })).toEqual(["PORT=8000", "NODE_ENV=production"]);
  });

  it("leaves an env with no PATH byte-identical", async () => {
    expect(await deployEnv({ A: "1", B: "2" })).toEqual([
      "PORT=8000",
      "NODE_ENV=production",
      "A=1",
      "B=2",
    ]);
  });

  // The operator typed the key by hand. Dropping it silently is how they end up
  // debugging an app whose env is missing a var with nothing in the log to
  // explain it — the same class of invisible failure as the 127 itself.
  it("warns exactly once, at warn level, naming the dropped key", async () => {
    const run = await deployRun(PROJECT_ENV);
    expect(warns(run)).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        message: droppedRuntimeEnvMessage(["PATH"]),
      },
    ]);
    // Independent of the shared helper: the line must name PATH itself, or it
    // tells the operator nothing actionable.
    expect(warns(run)[0]!.message).toContain("PATH");
  });

  it("warns about nothing when the project sets no PATH", async () => {
    // Guards the every-deploy spurious warning: the notice is gated on a real
    // drop, and a healthy deploy has no warn traffic at all.
    expect(warns(await deployRun({ A: "1", B: "2" }))).toEqual([]);
  });

  it("does not warn about the lowercase `path`, which it keeps", async () => {
    expect(warns(await deployRun({ path: "/lower/case" }))).toEqual([]);
  });
});

describe("DockerRuntime.deployServiceWorkload — project PATH never reaches container Env (#623)", () => {
  it("drops PATH and keeps every other key in declaration order", async () => {
    // No publicPort here, so the service Env is exactly the project's own keys —
    // which makes this the strict order assertion.
    expect(await serviceEnv(PROJECT_ENV)).toEqual(SURVIVORS);
  });

  it("emits no PATH assignment at all, so the image's ENV PATH survives", async () => {
    const env = await serviceEnv(PROJECT_ENV);
    expect(env.some((e) => e.startsWith("PATH="))).toBe(false);
  });

  it("keeps keys that merely CONTAIN 'PATH', and the lowercase `path`", async () => {
    const env = await serviceEnv(PROJECT_ENV);
    expect(env).toContain("MY_PATH=/opt/mine");
    expect(env).toContain("PATHOLOGY=chronic");
    expect(env).toContain("path=/lower/case");
  });

  it("a service whose ONLY var is PATH gets an empty Env", async () => {
    expect(await serviceEnv({ PATH: "/usr/bin" })).toEqual([]);
  });

  it("leaves an env with no PATH byte-identical", async () => {
    expect(await serviceEnv({ A: "1", B: "2" })).toEqual(["A=1", "B=2"]);
  });

  it("warns exactly once, prefixed with the service name", async () => {
    // A compose deploy interleaves every service's lines into one stream, so an
    // unprefixed notice can't be attributed to the service that carries the key.
    const run = await serviceRun(PROJECT_ENV);
    expect(warns(run)).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        message: `[web] ${droppedRuntimeEnvMessage(["PATH"])}`,
      },
    ]);
    const [warn] = warns(run);
    expect(warn!.message.startsWith("[web] ")).toBe(true);
    expect(warn!.message).toContain("PATH");
  });

  it("warns about nothing when the service sets no PATH", async () => {
    expect(warns(await serviceRun({ A: "1", B: "2" }))).toEqual([]);
  });

  it("does not warn about the lowercase `path`, which it keeps", async () => {
    expect(warns(await serviceRun({ path: "/lower/case" }))).toEqual([]);
  });
});
