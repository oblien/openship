/**
 * The end-to-end proof of the inline catalog build protocol (`advanced.build`).
 *
 * `build.service.test.ts` (the colocated unit test) proves the MATERIALIZE half
 * against a fake `runtime.buildImages`: that a service's `dockerfile` + `files[]`
 * land under a per-service subdir named `sanitizeComposeImageName(service.name)`
 * inside one shared context root, and that the resolved `BuildConfig` points at
 * that root. What it cannot prove — because the runtime is a spy — is that a real
 * `docker build` accepts that layout and that the author-facing COPY prefix
 * (`COPY <service-name>/<file>`) actually resolves against the shared root.
 *
 * This closes that gap through the REAL pipeline: a minimal build-only app whose
 * Dockerfile `COPY widget/marker.sh …`s a materialized file, drives the real
 * `buildComposeImages` → real `DockerRuntime.buildImages` → real `docker build`,
 * then RUNS the produced image. The image's ENTRYPOINT is the copied script, so a
 * successful run with the marker on stdout is proof the COPY prefix resolved end
 * to end — the one thing a template author gets wrong first and the string-match
 * catalog tests can never catch.
 *
 * Minimal on purpose (alpine + a shell script): it exercises the build PROTOCOL,
 * not a heavy real template. Neon/PostHog stay `available:false` pending a boot on
 * a host with the RAM their clusters need — that is a separate, larger proof.
 *
 * Opt-in real-daemon suite; an unreachable daemon FAILS under RUN_DOCKER_E2E=1:
 *
 *   RUN_DOCKER_E2E=1 bun run --cwd apps/api test:e2e
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BuildLogger, DEFAULT_RESOURCE_CONFIG, DockerRuntime } from "@repo/adapters";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

// buildComposeImages reads the project's services from the DB and broadcasts SSE
// status; neither is part of the build protocol under test. Stub the DB read (the
// unit test relies on the same seam) — the SSE broadcasts no-op safely without a
// live session. Only THIS file's module graph is mocked; other e2e files keep the
// real @repo/db.
const { listByProjectMock } = vi.hoisted(() => ({ listByProjectMock: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: { service: { listByProject: listByProjectMock } },
}));

import { buildComposeImages } from "../../src/modules/deployments/compose/build.service";

const execFileAsync = promisify(execFile);

const SERVICE_ID = "widget-svc";
const MARKER = "OPENSHIP_INLINE_BUILD_OK";

// Same minimal BuildConfigSnapshotLike the unit test uses — framework "docker" is
// what routes buildSpecFor down the Dockerfile branch.
const SNAPSHOT = {
  repoUrl: "",
  branch: "main",
  framework: "docker",
  buildImage: "",
  runtimeImage: "",
  packageManager: "",
  installCommand: "",
  buildCommand: "",
  outputDirectory: "",
  productionPaths: [] as string[],
  rootDirectory: "",
  port: 3000,
  startCommand: "",
  hasServer: true,
  hasBuild: false,
};

/** Force the docker CLI at the exact daemon the product resolved and built on. */
const dockerEnv = { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` };

describeDockerE2E("catalog inline build through the real build pipeline", () => {
  let runtime: DockerRuntime;
  let builtRef: string | undefined;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
  }, 300_000);

  afterAll(async () => {
    if (builtRef) {
      await execFileAsync("docker", ["rmi", "-f", builtRef], { env: dockerEnv }).catch(() => {});
    }
    await runtime?.dispose?.().catch(() => {});
  }, 120_000);

  it("materializes an inline Dockerfile, builds it on the real daemon, and the COPY <service>/<file> prefix resolves", async () => {
    // A build-ONLY service (image:null) whose Dockerfile COPYs a materialized file
    // by its service-subdir prefix. `widget/` here === sanitizeComposeImageName("widget").
    listByProjectMock.mockResolvedValue([
      {
        id: SERVICE_ID,
        name: "widget",
        enabled: true,
        image: null,
        build: null,
        advanced: {
          build: {
            dockerfile:
              "FROM alpine:3.20\n" +
              "COPY widget/marker.sh /marker.sh\n" +
              "RUN chmod +x /marker.sh\n" +
              'ENTRYPOINT ["/marker.sh"]\n',
            files: [{ path: "marker.sh", content: `#!/bin/sh\necho ${MARKER}\n` }],
          },
        },
        framework: null,
        buildCommand: null,
        startCommand: null,
        rootDirectory: null,
        dockerfile: null,
      },
    ]);

    const result = await buildComposeImages({
      project: {
        id: "p-widget",
        slug: "widget-app",
        name: "widget-app",
        localPath: null,
        workspacePrepareCommand: null,
      } as never,
      dep: { id: "d-widget", branch: "main", commitSha: null, trigger: "deploy", meta: null } as never,
      runtime,
      logger: new BuildLogger(() => {}),
      snapshot: SNAPSHOT as never,
      buildSessionId: "e2e-inline-build",
      buildEnvVars: {},
      buildResources: DEFAULT_RESOURCE_CONFIG,
    });

    // The build succeeded: a failed COPY prefix would have surfaced here, since a
    // missing `widget/marker.sh` fails `docker build` (COPY source not found).
    expect(result.buildFailures.size, [...result.buildFailures.values()].join("; ")).toBe(0);
    builtRef = result.builtImageRefs.get(SERVICE_ID);
    expect(builtRef, "a build ref should have been produced").toBeTruthy();

    // Run the produced image. Its ENTRYPOINT is the COPY'd script; the marker on
    // stdout proves the script is actually baked in, i.e. the prefix resolved and
    // the file was inside the build context — not merely that `docker build` exited 0.
    const { stdout } = await execFileAsync("docker", ["run", "--rm", builtRef!], { env: dockerEnv });
    expect(stdout).toContain(MARKER);
  }, 300_000);
});
