import { BuildLogger, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline is only wired here, not exercised: every collaborator is a side
// effect on the DB, the SSH host, or the SSE stream. Stubbing them leaves exactly
// one thing under test — which branch the cancel flag takes.
const mocks = vi.hoisted(() => ({
  buildComposeImages: vi.fn(),
  deployComposeServices: vi.fn(),
  cleanupBuildArtifact: vi.fn(async () => {}),
  onCancelled: vi.fn(async () => {}),
  onFailure: vi.fn(async () => {}),
  onReconciling: vi.fn(async () => {}),
  onSuccess: vi.fn(async () => {}),
  setDeploymentStatus: vi.fn(async () => {}),
  promptUser: vi.fn(async () => "migrate"),
}));

vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("./build.service", () => ({ buildComposeImages: mocks.buildComposeImages }));
vi.mock("./deploy.service", () => ({ deployComposeServices: mocks.deployComposeServices }));
vi.mock("../deployment-lifecycle", () => ({
  cleanupBuildArtifact: mocks.cleanupBuildArtifact,
  onCancelled: mocks.onCancelled,
  onFailure: mocks.onFailure,
  onReconciling: mocks.onReconciling,
  onSuccess: mocks.onSuccess,
  setDeploymentStatus: mocks.setDeploymentStatus,
  routeIssuesWarning: (issues: string[]) => issues.join(", "),
}));
vi.mock("../session-manager", () => ({
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
  promptUser: mocks.promptUser,
}));

import { executeComposePipeline } from "./pipeline";

/**
 * `setDeploymentStatus` has NO terminal-state guard, so the cancel branch is the
 * only thing standing between a cancelled deployment and a live one: fall through
 * and the "cancelled" row is flipped back to "deploying" and the containers the
 * user cancelled start anyway. Pinned here because the failure is silent — the
 * deploy succeeds, which is exactly what it must not do.
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

/** Thrown BY the deploy step, so "did we get there" needs nothing downstream of it. */
const REACHED_DEPLOY = new Error("reached the deploy step");

async function run(composeBuild: Record<string, unknown>) {
  mocks.buildComposeImages.mockResolvedValue(composeBuild);
  // Deploying for real would drag in every collaborator past this point (and pin
  // this test to whatever the happy path grows next). All that matters here is
  // whether control reaches it at all.
  mocks.deployComposeServices.mockRejectedValue(REACHED_DEPLOY);

  await executeComposePipeline({
    project: { id: "p1", slug: "app", name: "app", webhookDomain: null } as never,
    dep: { id: "d1", branch: "main", commitSha: null, trigger: "deploy", meta: null } as never,
    runtime: { name: "docker" } as never,
    routing: {} as never,
    ssl: {} as never,
    system: null,
    executor: null,
    usesManagedRouting: false,
    logger: new BuildLogger(() => {}),
    ctx: { dep: { id: "d1" }, provisioned: {} } as never,
    snapshot: SNAPSHOT as never,
    buildSessionId: "bld_x",
    buildEnvVars: {},
    buildResources: DEFAULT_RESOURCE_CONFIG,
    runtimeResources: DEFAULT_RESOURCE_CONFIG,
  });
}

describe("executeComposePipeline — cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops before the deploy phase and never re-flips the status", async () => {
    await run({
      cancelled: true,
      buildFailures: new Map(),
      imageRefs: new Map(),
      builtImageRefs: new Map([["svc-0", "img/svc-0"]]),
      durationMs: 5,
    });

    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
    expect(mocks.setDeploymentStatus).not.toHaveBeenCalled();
    expect(mocks.onCancelled).toHaveBeenCalledWith(expect.anything(), 5);
    // Whatever finished building before the cancel landed is garbage — nothing
    // references it and no deploy will.
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(expect.anything(), "img/svc-0");
  });

  it("still cleans up when a built image refuses to delete", async () => {
    mocks.cleanupBuildArtifact.mockRejectedValueOnce(new Error("image in use"));

    await run({
      cancelled: true,
      buildFailures: new Map(),
      imageRefs: new Map(),
      builtImageRefs: new Map([
        ["svc-0", "img/svc-0"],
        ["svc-1", "img/svc-1"],
      ]),
      durationMs: 5,
    });

    // A stuck image must not abort the cancel: the second cleanup still runs and
    // the deployment still lands on `cancelled`.
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.onCancelled).toHaveBeenCalledTimes(1);
    expect(mocks.deployComposeServices).not.toHaveBeenCalled();
  });

  // Negative control: without it, a branch that always returned early would pass
  // both tests above.
  it("proceeds to deploy when the build was not cancelled", async () => {
    await expect(
      run({
        cancelled: false,
        buildFailures: new Map(),
        imageRefs: new Map([["svc-0", "img/svc-0"]]),
        builtImageRefs: new Map([["svc-0", "img/svc-0"]]),
        durationMs: 5,
      }),
    ).rejects.toBe(REACHED_DEPLOY);

    expect(mocks.onCancelled).not.toHaveBeenCalled();
    expect(mocks.setDeploymentStatus).toHaveBeenCalledWith("d1", "deploying", expect.anything());
    const deployOpts = mocks.deployComposeServices.mock.calls[0]?.[4];
    const prompt = { promptId: "edge_conflict" };
    await expect(deployOpts.promptUser(prompt)).resolves.toBe("migrate");
    expect(mocks.promptUser).toHaveBeenCalledWith("d1", prompt);
  });
});
