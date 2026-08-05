import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  server: {
    id: "srv-local",
    isLocal: true,
    sshHost: "127.0.0.1",
    sshPort: 22,
    sshUser: "whirmill",
  },
  executor: { kind: "host-executor" },
  platformConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@repo/adapters", () => ({
  DockerRuntime: { create: vi.fn() },
  createPlatform: vi.fn(async (config: Record<string, unknown>) => {
    h.platformConfigs.push(config);
    return { target: "selfhosted", runtime: {}, routing: {}, ssl: {}, system: {}, executor: null };
  }),
  resolveStaticOutputPath: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      getInOrganization: vi.fn(async () => h.server),
      listByOrganization: vi.fn(async () => [h.server]),
      update: vi.fn(async () => undefined),
    },
  },
}));

vi.mock("./box-org", () => ({
  isLocalHostRow: vi.fn(async (server: { isLocal?: boolean }) => Boolean(server.isLocal)),
}));

vi.mock("./ssh-manager", () => ({
  sshManager: { acquire: vi.fn(async () => h.executor) },
  buildSshConfig: vi.fn(async (server: { sshHost: string }) => ({
    host: server.sshHost,
    port: 22,
    username: "root",
  })),
}));

vi.mock("./provision-lock", () => ({
  createProvisionLock: vi.fn(() => ({ run: (fn: () => unknown) => fn() })),
}));
vi.mock("./cloud/client", () => ({ cloudClient: {}, getOrgCloudToken: vi.fn() }));
vi.mock("./cloud/transport", () => ({ resolveOrgCloudUserId: vi.fn() }));
vi.mock("./controller-helpers", () => ({ platform: () => ({ target: "selfhosted" }) }));
vi.mock("./acme-config", () => ({ resolveAcmeProviderOptions: () => ({}) }));
vi.mock("../config", () => ({ env: {} }));

const { resolveTargetPlatform } = await import("./deployment-runtime");

beforeEach(() => {
  h.server = {
    id: "srv-local",
    isLocal: true,
    sshHost: "127.0.0.1",
    sshPort: 22,
    sshUser: "whirmill",
  };
  h.platformConfigs = [];
  vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
  vi.stubEnv("OPENSHIP_EDGE_CONTAINER", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveTargetPlatform — local compose edge", () => {
  it.each(["docker", "bare"] as const)(
    "keeps the host executor for an isLocal %s workload but selects the mounted local edge",
    async (runtimeMode) => {
      await resolveTargetPlatform("server", runtimeMode, "srv-local", "org-1");

      expect(h.platformConfigs).toHaveLength(1);
      expect(h.platformConfigs[0]).toMatchObject({
        target: "selfhosted",
        runtime: runtimeMode,
        executor: h.executor,
        localEdgeContainer: "openship-edge",
      });
    },
  );

  it("honours the configured local edge container name", async () => {
    vi.stubEnv("OPENSHIP_EDGE_CONTAINER", "custom-edge");

    await resolveTargetPlatform("server", "docker", "srv-local", "org-1");

    expect(h.platformConfigs[0]?.localEdgeContainer).toBe("custom-edge");
  });

  it("does not select the control-plane edge for a remote server", async () => {
    h.server = {
      id: "srv-remote",
      isLocal: false,
      sshHost: "203.0.113.8",
      sshPort: 22,
      sshUser: "root",
    };

    await resolveTargetPlatform("server", "docker", "srv-remote", "org-1");

    expect(h.platformConfigs[0]?.localEdgeContainer).toBeUndefined();
    expect(h.platformConfigs[0]).toHaveProperty("ssh");
  });

  it("keeps the legacy host/bare edge path when docker-edge mode is disabled", async () => {
    vi.stubEnv("OPENSHIP_EDGE_MODE", "host");

    await resolveTargetPlatform("server", "docker", "srv-local", "org-1");

    expect(h.platformConfigs[0]?.localEdgeContainer).toBeUndefined();
  });
});
