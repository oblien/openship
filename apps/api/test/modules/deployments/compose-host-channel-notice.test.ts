import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildLogger, CommandExecutor, MultiServiceRuntimeAdapter } from "@repo/adapters";
import type { Deployment, Project } from "@repo/db";

/**
 * A compose deploy to a box that cannot drive its host must SAY so, once, in the
 * deploy log (#509).
 *
 * With the host channel demoted to refuse-on-use, the #509 repro stops failing and
 * starts silently degrading, which is its own bug: every host touchpoint absorbs the
 * refusal on its own terms. `allocateHostPort` reports "couldn't read occupancy" — and
 * only under `loopback-port` routing — while the routing preflight logs "deploy
 * continues". Neither names the channel or a fix, so the first legible symptom is a
 * container that dies later over a config file that never landed on the host.
 *
 * Driven end-to-end from the real demotion (a `--no-host-control` box resolving its
 * local row) rather than from a stubbed notice, because the bug was never in the
 * wording — it was that nothing carried the fact from the decision to the log.
 */

const h = vi.hoisted(() => ({
  localRow: {
    id: "srv-local",
    isLocal: true,
    sshHost: "127.0.0.1",
    sshPort: 22,
    sshUser: "root",
  },
  convergeTargetHostPortClaims: vi.fn(),
  convergeTargetHostPortClaimsUnlocked: vi.fn(),
  prepareTargetPinnedHostPorts: vi.fn(),
  allocateAndReservePinnedHostPort: vi.fn(),
  releaseNewPinnedHostPortClaims: vi.fn(),
  reserveResolvedLoopbackRoutes: vi.fn(),
  upsertServiceDeployment: vi.fn(),
  services: [] as Array<Record<string, unknown>>,
  previousServiceRows: [] as Array<Record<string, unknown>>,
  previousDeployment: { id: "d-old", containerId: "compose", createdAt: null } as Record<
    string,
    unknown
  >,
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      get: async () => h.localRow,
      getInOrganization: async () => h.localRow,
      update: async () => {},
    },
    service: {
      listByProject: async () => h.services,
      listByDeployment: async () => h.previousServiceRows,
      upsertServiceDeployment: (...args: unknown[]) => h.upsertServiceDeployment(...args),
      markServiceDeploymentFailed: async () => undefined,
    },
    deployment: {
      findById: async () => h.previousDeployment,
    },
    project: {
      getEnvMap: async () => ({}),
      listEnvVarChangeMeta: async () => [],
    },
    domain: {
      listByProject: async () => [],
      findByHostname: async () => null,
      findOrCreateWithStatus: async (input: Record<string, unknown>) => ({
        domain: {
          id: `dom-${String(input.hostname)}`,
          status: "pending",
          verified: false,
          sslStatus: "none",
          ...input,
        },
        created: true,
      }),
    },
  },
}));

// The row IS this box. Keyed off the flag so the test doesn't depend on loopback
// resolution or on which org owns the box.
vi.mock("../../../src/lib/box-org", () => ({
  isLocalHostRow: async (row: { isLocal?: boolean }) => Boolean(row?.isLocal),
  boxOwningOrgId: async () => "org1",
}));

vi.mock("../../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (f: () => unknown) => f() }),
}));

vi.mock("../../../src/modules/deployments/pinned-host-ports", () => ({
  withHostPortTargetLock: (_target: unknown, fn: () => unknown) => fn(),
  prepareTargetPinnedHostPorts: (...args: unknown[]) => h.prepareTargetPinnedHostPorts(...args),
  convergeTargetHostPortClaims: (...args: unknown[]) => h.convergeTargetHostPortClaims(...args),
  convergeTargetHostPortClaimsUnlocked: (...args: unknown[]) =>
    h.convergeTargetHostPortClaimsUnlocked(...args),
  allocateAndReservePinnedHostPort: (...args: unknown[]) =>
    h.allocateAndReservePinnedHostPort(...args),
  releaseNewPinnedHostPortClaims: (...args: unknown[]) => h.releaseNewPinnedHostPortClaims(...args),
}));

vi.mock("../../../src/modules/deployments/observed-host-port-claims", () => ({
  reserveResolvedLoopbackRoutes: (...args: unknown[]) => h.reserveResolvedLoopbackRoutes(...args),
}));

const { resolveServerExecutor } = await import("../../../src/lib/deployment-runtime");
const { deployComposeServices } =
  await import("../../../src/modules/deployments/compose/deploy.service");

/** Collects what the deploy log was told, in order. */
function recordingLogger() {
  const lines: { message: string; level: string }[] = [];
  const logger = {
    log: (message: string, level = "info") => lines.push({ message, level }),
    step: () => {},
    callback: (entry: { message: string; level?: string }) =>
      lines.push({ message: entry.message, level: entry.level ?? "info" }),
  } as unknown as BuildLogger;
  return { logger, lines };
}

/** Stops the deploy at the first thing after the notice, so the test exercises the
 *  emission point and its ORDER without needing a Docker host. */
function haltingRuntime(name: "docker" | "cloud" = "docker", containerIp = true) {
  return {
    name,
    supports: (capability: string) => capability === "containerIp" && containerIp,
    ensureServiceGroup: vi.fn(async () => {
      throw new Error("halt: nothing past the notice is under test");
    }),
  } as unknown as MultiServiceRuntimeAdapter;
}

function carriedRuntime(containerIp = true) {
  return {
    name: "docker",
    supports: (capability: string) =>
      capability === "containerInfo" || (capability === "containerIp" && containerIp),
    ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
    getContainerInfo: vi.fn(async () => ({
      status: "running",
      ip: "172.18.0.2",
      hostPort: 30_000,
      hostPortByContainerPort: { 8080: 30_000 },
    })),
    destroy: vi.fn(async () => undefined),
  } as unknown as MultiServiceRuntimeAdapter;
}

function startingRuntime() {
  return {
    name: "docker",
    unsupportedComposeKeys: new Set(),
    supports: (capability: string) => capability === "containerIp",
    ensureServiceGroup: vi.fn(async () => ({ id: "group-1" })),
    deployServiceWorkload: vi.fn(async () => ({
      status: "running",
      containerId: "container-new",
      ip: "172.18.0.3",
    })),
    destroy: vi.fn(async () => undefined),
    getContainerIp: vi.fn(async () => "172.18.0.3"),
  } as unknown as MultiServiceRuntimeAdapter;
}

const project = { id: "p1", slug: "app", organizationId: "org1" } as unknown as Project;
const dep = {
  id: "d1",
  organizationId: "org1",
  environment: "production",
} as unknown as Deployment;
const localHostPortTarget = {
  targetKey: "local" as const,
  legacyTargetKeys: [],
  stable: true,
};

async function demotedExecutor(): Promise<CommandExecutor> {
  const { executor } = await resolveServerExecutor("srv-local", "org1");
  return executor;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  h.services = [
    {
      id: "svc-web",
      projectId: "p1",
      name: "web",
      enabled: true,
      dependsOn: [],
      advanced: null,
      ports: ["8080"],
      image: "nginx:alpine",
      exposed: true,
      exposedPort: "8080",
      domainType: "custom",
      customDomain: "web.example.com",
      publicEndpoints: [],
    },
  ];
  h.previousServiceRows = [
    {
      id: "sd-old",
      deploymentId: "d-old",
      serviceId: "svc-web",
      serviceName: "web",
      containerId: "container-old",
      status: "success",
      imageRef: "nginx:alpine",
      ip: "172.18.0.2",
      hostPort: 30_000,
      hostPorts: { 8080: 30_000 },
    },
  ];
  h.previousDeployment = { id: "d-old", containerId: "compose", createdAt: null };
  h.prepareTargetPinnedHostPorts.mockResolvedValue([]);
  h.allocateAndReservePinnedHostPort.mockImplementation(async (input) => ({
    port: 30_000,
    scanned: true,
    claim: {
      id: "hpc-web",
      targetKey: "local",
      ...input.owner,
      port: 30_000,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  }));
  h.releaseNewPinnedHostPortClaims.mockResolvedValue(0);
  h.reserveResolvedLoopbackRoutes.mockResolvedValue([]);
  h.convergeTargetHostPortClaims.mockResolvedValue({ released: 0, retained: [] });
  h.convergeTargetHostPortClaimsUnlocked.mockResolvedValue({ released: 0, retained: [] });
  h.upsertServiceDeployment.mockResolvedValue(undefined);
});

function addDisabledPreviousService() {
  h.services.push({
    id: "svc-disabled",
    projectId: "p1",
    name: "disabled",
    enabled: false,
    dependsOn: [],
    advanced: null,
    ports: ["9090"],
    image: "nginx:alpine",
    exposed: false,
    publicEndpoints: [],
  });
  h.previousServiceRows.push({
    id: "sd-disabled",
    deploymentId: "d-old",
    serviceId: "svc-disabled",
    serviceName: "disabled",
    containerId: "container-disabled",
    status: "success",
    imageRef: "nginx:alpine",
    ip: "172.18.0.4",
    hostPort: 30_001,
    hostPorts: { 9090: 30_001 },
  });
}

describe("compose deploy — host channel unavailable", () => {
  it("states the skip, the reason and the reassurance, before any host touchpoint", async () => {
    // The real demotion path: host control off is the same typed error an
    // unprovisioned container channel raises, and it is the one a test can produce
    // without a container.
    vi.stubEnv("OPENSHIP_HOST_CONTROL", "false");
    const executor = await demotedExecutor();

    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, {
        executor,
        hostPortTarget: localHostPortTarget,
      }),
    ).rejects.toThrow(/halt/);

    const notice = lines.find((l) => l.message.includes("Host operations are unavailable"));
    expect(
      notice,
      `no host-channel notice in the deploy log:\n${lines.map((l) => l.message).join("")}`,
    ).toBeDefined();
    expect(notice!.level).toBe("warn");
    // The reason, with the remedy the executor refuses every call with.
    expect(notice!.message).toContain("OPENSHIP_HOST_CONTROL=false");
    // From @repo/core — the deploy in progress still succeeds.
    expect(notice!.message).toContain("Ordinary deploys to this box still work");
    // Said ONCE per deploy, not per touchpoint.
    expect(lines.filter((l) => l.message.includes("Host operations are unavailable"))).toHaveLength(
      1,
    );
    // Before the first host-touching step, so it reads as the cause of what follows
    // rather than as a footnote to it.
    expect(lines.indexOf(notice!)).toBeLessThan(
      lines.findIndex((l) => l.message.includes("service group")),
    );
  });

  it("is independent of the routing strategy", async () => {
    // The pre-existing hint appeared only under `loopback-port` — the one strategy that
    // pins a host port. Every strategy loses the same host operations.
    vi.stubEnv("OPENSHIP_HOST_CONTROL", "false");
    const executor = await demotedExecutor();

    for (const routeStrategy of ["container-ip", "loopback-port", undefined]) {
      const { logger, lines } = recordingLogger();
      await expect(
        deployComposeServices(
          { ...project, routeStrategy } as unknown as Project,
          dep,
          haltingRuntime(),
          logger,
          { executor, hostPortTarget: localHostPortTarget },
        ),
      ).rejects.toThrow(/halt/);
      expect(
        lines.some((l) => l.message.includes("Host operations are unavailable")),
        `no notice under routeStrategy=${String(routeStrategy)}`,
      ).toBe(true);
    }
  });

  it("stays quiet when the channel is fine", async () => {
    // Nothing was demoted, so there is nothing to report — a notice here would be a
    // false claim about the box, which is how the dashboard came to name the wrong
    // machine (#490).
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, {
        executor: {
          exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        } as unknown as CommandExecutor,
        hostPortTarget: localHostPortTarget,
      }),
    ).rejects.toThrow(/halt/);
    expect(lines.some((l) => l.message.includes("Host operations are unavailable"))).toBe(false);
  });

  it("stays quiet on cloud, which has no executor and no host", async () => {
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime("cloud"), logger, { executor: null }),
    ).rejects.toThrow(/halt/);
    expect(lines.some((l) => l.message.includes("Host operations are unavailable"))).toBe(false);
  });

  it("fails before container activation when a loopback target has no executor", async () => {
    const runtime = haltingRuntime();
    const ensureServiceGroup = vi.mocked(runtime.ensureServiceGroup);
    const { logger, lines } = recordingLogger();

    await expect(
      deployComposeServices(project, dep, runtime, logger, {
        executor: null,
        hostPortTarget: localHostPortTarget,
      }),
    ).rejects.toThrow("physical target executor");
    expect(ensureServiceGroup).not.toHaveBeenCalled();
  });

  it("does the same for explicit container-ip when the runtime has no container IP", async () => {
    const runtime = haltingRuntime("docker", false);
    const ensureServiceGroup = vi.mocked(runtime.ensureServiceGroup);
    const { logger } = recordingLogger();

    await expect(
      deployComposeServices(
        { ...project, routeStrategy: "container-ip" } as unknown as Project,
        dep,
        runtime,
        logger,
        { executor: null, hostPortTarget: localHostPortTarget },
      ),
    ).rejects.toThrow("physical target executor");
    expect(ensureServiceGroup).not.toHaveBeenCalled();
  });

  it("converges a non-loopback transition to an empty desired set under its own lock", async () => {
    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(h.convergeTargetHostPortClaims).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", desiredPublishes: [] }),
    );
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });

  it("converges only after every obsolete service workload has been stopped", async () => {
    addDisabledPreviousService();
    const runtime = carriedRuntime();
    const destroy = vi.mocked(runtime.destroy);
    const { logger } = recordingLogger();

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      runtime,
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(destroy).toHaveBeenCalledWith("container-disabled");
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
      h.convergeTargetHostPortClaims.mock.invocationCallOrder[0]!,
    );
  });

  it("retains claims when an obsolete service workload cannot be stopped", async () => {
    addDisabledPreviousService();
    const runtime = carriedRuntime();
    vi.mocked(runtime.destroy).mockRejectedValueOnce(new Error("daemon unavailable"));
    const { logger, lines } = recordingLogger();

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      runtime,
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.warning).toContain("obsolete workload could not be stopped");
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
    expect(
      lines.some(
        (line) => line.level === "warn" && line.message.includes("reservations were retained"),
      ),
    ).toBe(true);
  });

  it("keeps a ready Compose deploy ready and surfaces deferred claim cleanup", async () => {
    h.convergeTargetHostPortClaims.mockRejectedValueOnce(new Error("edge scan unavailable"));
    const { logger, lines } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "container-ip",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.warning).toContain("Host-port reservation cleanup was deferred");
    expect(
      lines.some(
        (line) =>
          line.level === "warn" &&
          line.message.includes("Host-port reservation cleanup was deferred"),
      ),
    ).toBe(true);
  });

  it("never releases an activated claim when failed-workload cleanup is uncertain", async () => {
    h.reserveResolvedLoopbackRoutes.mockRejectedValueOnce(
      new Error("route ownership verification failed"),
    );
    const runtime = startingRuntime();
    vi.mocked(runtime.destroy).mockRejectedValue(new Error("daemon unavailable"));
    const { logger, lines } = recordingLogger();
    const routing = {
      registerRoute: vi.fn(async () => undefined),
      removeRoute: vi.fn(async () => undefined),
    } as never;
    const ssl = {
      provisionCert: vi.fn(async () => ({ verified: false })),
      renewCert: vi.fn(),
      verifyCert: vi.fn(),
      installCert: vi.fn(),
    } as never;

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: null,
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      runtime,
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        routing,
        ssl,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("failed");
    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalled();
    expect(h.releaseNewPinnedHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
    expect(lines.some((line) => line.message.includes("retained until the next"))).toBe(true);
  });

  it("uses the already-held target lock for a loopback deploy", async () => {
    const { logger } = recordingLogger();
    const routing = {
      registerRoute: vi.fn(async () => undefined),
      removeRoute: vi.fn(async () => undefined),
    } as never;
    const ssl = {
      provisionCert: vi.fn(async () => ({ verified: false })),
      renewCert: vi.fn(),
      verifyCert: vi.fn(),
      installCert: vi.fn(),
    } as never;
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
        routing,
        ssl,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("ready");
    expect(h.convergeTargetHostPortClaimsUnlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        desiredPublishes: [{ serviceId: "svc-web", containerPort: 8080, hostPort: 30_000 }],
      }),
    );
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
  });

  it("does not run project-wide convergence for strict single-service scope", async () => {
    const { logger } = recordingLogger();
    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: "d-old",
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      carriedRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        targetServiceIds: new Set(),
        strictScope: true,
      },
    );

    expect(result.status).toBe("ready");
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });

  it("retains every claim while a started service has an indeterminate outcome", async () => {
    h.upsertServiceDeployment
      .mockRejectedValueOnce(new Error("Channel open failure: connection lost"))
      .mockResolvedValueOnce(undefined);
    const { logger } = recordingLogger();

    const result = await deployComposeServices(
      {
        ...project,
        activeDeploymentId: null,
        routeStrategy: "loopback-port",
      } as unknown as Project,
      dep,
      startingRuntime(),
      logger,
      {
        executor: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as never,
        hostPortTarget: localHostPortTarget,
        routing: {
          registerRoute: vi.fn(async () => undefined),
          removeRoute: vi.fn(async () => undefined),
        } as never,
        ssl: {
          provisionCert: vi.fn(async () => ({ verified: false })),
          renewCert: vi.fn(),
          verifyCert: vi.fn(),
          installCert: vi.fn(),
        } as never,
        usesManagedRouting: true,
      },
    );

    expect(result.status).toBe("reconciling");
    expect(h.allocateAndReservePinnedHostPort).toHaveBeenCalled();
    expect(h.releaseNewPinnedHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaims).not.toHaveBeenCalled();
    expect(h.convergeTargetHostPortClaimsUnlocked).not.toHaveBeenCalled();
  });
});
