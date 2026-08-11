import { BuildLogger, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import { describe, expect, it, vi } from "vitest";

// Same stubs as build.service.test.ts: the DB row read and the SSE broadcast are
// side effects this contract doesn't depend on (and importing the real @repo/db
// would risk the PGlite single-instance lock).
const { listByProjectMock } = vi.hoisted(() => ({ listByProjectMock: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: { service: { listByProject: listByProjectMock } },
}));
vi.mock("../session-manager", () => ({
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
}));

import { buildComposeImages } from "./build.service";

/**
 * A cancelled service build must NOT be laundered into a build failure. The
 * compose pipeline branches on the two differently: a failure deploys whatever
 * did build (and marks the deployment failed), while a cancel has to stop the
 * pipeline before it flips the row back to "deploying" — so losing the
 * distinction here is what silently deploys a cancelled deployment.
 */

const SNAPSHOT = {
  repoUrl: "https://example.com/repo.git",
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

function service(name: string) {
  return {
    id: name,
    name,
    enabled: true,
    image: null,
    build: ".",
    advanced: null,
    framework: null,
    buildCommand: null,
    startCommand: null,
    rootDirectory: null,
    dockerfile: null,
  };
}

/** Drive buildComposeImages with a fake batch build that returns `statuses` in order. */
async function run(statuses: Array<"deploying" | "failed" | "cancelled">) {
  const services = statuses.map((_, index) => service(`svc-${index}`));
  listByProjectMock.mockResolvedValue(services);

  const runtime = {
    name: "docker" as const,
    build: vi.fn(),
    buildImages: vi.fn(async (items: Array<Record<string, unknown>>) => {
      items.forEach((item, index) => {
        const status = statuses[index]!;
        (item.onResult as (r: unknown) => void)({
          sessionId: `sess-svc-${index}`,
          status,
          imageRef: status === "deploying" ? `img/svc-${index}` : undefined,
          errorMessage: status === "failed" ? "boom" : undefined,
          durationMs: 1,
        });
      });
    }),
  };

  return buildComposeImages({
    project: {
      id: "p1",
      slug: "app",
      name: "app",
      localPath: null,
      workspacePrepareCommand: null,
    } as never,
    dep: { id: "d1", branch: "main", commitSha: null, trigger: "deploy", meta: null } as never,
    runtime: runtime as never,
    logger: new BuildLogger(() => {}),
    snapshot: SNAPSHOT as never,
    buildSessionId: "sess",
    buildEnvVars: {},
    buildResources: DEFAULT_RESOURCE_CONFIG,
  });
}

describe("buildComposeImages — cancellation", () => {
  it("reports a cancelled service as cancelled, not as a build failure", async () => {
    const result = await run(["cancelled", "cancelled"]);

    expect(result.cancelled).toBe(true);
    expect(result.buildFailures.size).toBe(0);
    expect(result.imageRefs.size).toBe(0);
    expect(result.builtImageRefs.size).toBe(0);
  });

  it("flags the whole build cancelled even when an earlier service finished", async () => {
    const result = await run(["deploying", "cancelled"]);

    // svc-0's image exists and is reported so the pipeline can clean it up; the
    // cancel still has to win over "1 of 2 built, deploy what we have".
    expect(result.cancelled).toBe(true);
    expect(result.buildFailures.size).toBe(0);
    expect([...result.builtImageRefs.values()]).toEqual(["img/svc-0"]);
  });

  it("leaves ordinary failures untouched", async () => {
    const result = await run(["deploying", "failed"]);

    expect(result.cancelled).toBe(false);
    expect(result.buildFailures.size).toBe(1);
  });
});
