import { BuildLogger, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SUCCESSFUL compose deploy must never reclaim the artifact of a service it
 * just published.
 *
 * `deployedServiceIds` used to be built from `services.filter((s) => s.containerId)`.
 * A self-hosted static sub-app is served from disk by the edge, so it deliberately
 * carries `staticRoot` INSTEAD of a containerId (see `MultiServiceDeployResult.services`
 * and the static branch's `results.push` in deploy.service.ts) while still appearing in
 * `composeBuild.builtImageRefs`. Reading "no containerId" as "not deployed" put its
 * doc-root — the very path the vhost had just been pointed at — into the unused list,
 * so `cleanupBuildArtifact` → `runtime.destroy(path)` → `rm -rf`'d the site. The deploy
 * reported ready and every request 404'd.
 *
 * The exemption must stay NARROW (a genuinely undeployed service's image is still
 * garbage) and must NOT extend to a failed deploy, whose staging dirs are garbage by
 * definition.
 */

// Everything the pipeline touches is a side effect on the DB, the SSH host or the
// SSE stream. Stubbing them leaves one thing under test: which built artifacts the
// cleanup loop decides are unused.
const mocks = vi.hoisted(() => ({
  buildComposeImages: vi.fn(),
  deployComposeServices: vi.fn(),
  cleanupBuildArtifact: vi.fn(async () => {}),
  onFailure: vi.fn(async () => {}),
  onNoChanges: vi.fn(async () => {}),
  onReconciling: vi.fn(async () => {}),
  onSuccess: vi.fn(async () => {}),
  setDeploymentStatus: vi.fn(async () => {}),
}));

vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("./build.service", () => ({ buildComposeImages: mocks.buildComposeImages }));
vi.mock("./deploy.service", () => ({
  deployComposeServices: mocks.deployComposeServices,
  // The no-changes settle is a separate branch that runs AFTER the cleanup loop
  // under test; every result below deployed something.
  composeDeployMadeNoChanges: () => false,
}));
vi.mock("../deployment-lifecycle", () => ({
  cleanupBuildArtifact: mocks.cleanupBuildArtifact,
  onCancelled: vi.fn(async () => {}),
  onFailure: mocks.onFailure,
  onNoChanges: mocks.onNoChanges,
  onReconciling: mocks.onReconciling,
  onSuccess: mocks.onSuccess,
  setDeploymentStatus: mocks.setDeploymentStatus,
  routeIssuesWarning: (issues: string[]) => issues.join(", "),
}));
vi.mock("../session-manager", () => ({
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
}));

import { executeComposePipeline } from "./pipeline";

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

/** The promoted release dir a static sub-app is served from — same value the
 *  vhost's root points at and the same value that lands in builtImageRefs. */
const STATIC_ROOT = "/opt/openship/static/releases/dep_1-svc_1";

type ServiceResult = {
  serviceId: string;
  serviceName: string;
  status: string;
  containerId?: string;
  staticRoot?: string;
};

function composeResult(
  status: "ready" | "failed",
  services: ServiceResult[],
): Record<string, unknown> {
  return {
    status,
    services,
    summary: {
      total: services.length,
      successful: services.length,
      deployed: services.length,
      failed: 0,
      mutated: true,
      failedServices: [] as string[],
    },
    ...(status === "failed" ? { error: "service create failed" } : {}),
  };
}

async function run(
  builtImageRefs: Map<string, string>,
  result: Record<string, unknown>,
): Promise<void> {
  mocks.buildComposeImages.mockResolvedValue({
    cancelled: false,
    buildFailures: new Map(),
    imageRefs: new Map(builtImageRefs),
    builtImageRefs,
    durationMs: 5,
  });
  mocks.deployComposeServices.mockResolvedValue(result);

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

describe("executeComposePipeline — built-artifact cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never reclaims a static sub-app's published doc-root", async () => {
    await run(
      new Map([["svc_1", STATIC_ROOT]]),
      composeResult("ready", [
        { serviceId: "svc_1", serviceName: "site", status: "running", staticRoot: STATIC_ROOT },
      ]),
    );

    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
    // The deploy DID succeed — which is what made the old bug silent: ready row,
    // deleted doc-root, 404 on every request.
    expect(mocks.onSuccess).toHaveBeenCalledTimes(1);
  });

  it("still reclaims the image of a service that built but never deployed", async () => {
    await run(
      new Map([
        ["svc_1", STATIC_ROOT],
        ["svc_2", "openship/svc_2:bld_x"],
      ]),
      composeResult("ready", [
        { serviceId: "svc_1", serviceName: "site", status: "running", staticRoot: STATIC_ROOT },
        // No containerId AND no staticRoot: nothing is serving from this build, so
        // the staticRoot exemption must not have widened into a blanket one.
        { serviceId: "svc_2", serviceName: "api", status: "skipped" },
      ]),
    );

    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/svc_2:bld_x",
    );
  });

  it("leaves a running container service's image in place", async () => {
    await run(
      new Map([["svc_1", "openship/svc_1:bld_x"]]),
      composeResult("ready", [
        { serviceId: "svc_1", serviceName: "api", status: "running", containerId: "c_1" },
      ]),
    );

    expect(mocks.cleanupBuildArtifact).not.toHaveBeenCalled();
  });

  it("reclaims every built artifact, static one included, when the deploy failed", async () => {
    await run(
      new Map([
        ["svc_1", STATIC_ROOT],
        ["svc_2", "openship/svc_2:bld_x"],
      ]),
      composeResult("failed", [
        { serviceId: "svc_1", serviceName: "site", status: "running", staticRoot: STATIC_ROOT },
      ]),
    );

    // Separate, deliberately unconditional loop: a failed deploy publishes nothing,
    // so its staging dir is garbage even though the service reported a staticRoot.
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(expect.anything(), STATIC_ROOT);
    expect(mocks.cleanupBuildArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "openship/svc_2:bld_x",
    );
    expect(mocks.onFailure).toHaveBeenCalledTimes(1);
    expect(mocks.onSuccess).not.toHaveBeenCalled();
  });
});
