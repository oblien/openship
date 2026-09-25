import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real runtime resolvers and real pool/idle timers. Only the
// network transports and database are replaced; no server is contacted.
const h = vi.hoisted(() => ({
  executors: [] as Array<{ closed: boolean; dispose: () => Promise<void>; readFile: () => Promise<string> }>,
  runtimes: [] as Array<{ name: string; dispose: () => Promise<void> }>,
  factoryCalls: 0,
  waitForFactory: null as Promise<void> | null,
  failDispose: false,
  invalidSsh: false,
  disposalCalls: 0,
  sslCalls: 0,
  waitForSsl: null as Promise<void> | null,
  failSsl: false,
  infraWork: vi.fn(async (_exec: { readFile: () => Promise<string> }) => {}),
}));

vi.mock("@repo/adapters", async () => {
  const executor = () => {
    const value = {
      closed: false,
      async dispose() { value.closed = true; },
      async readFile() {
        if (value.closed) throw new Error("SSH connection was closed");
        return "0123456789abcdef0123456789abcdef";
      },
    };
    h.executors.push(value);
    return value;
  };
  const runtime = async (name = "docker") => {
    h.factoryCalls++;
    if (h.waitForFactory) await h.waitForFactory;
    const value = {
      name,
      async dispose() {
        h.disposalCalls++;
        if (h.failDispose) throw new Error("bridge cleanup failed");
      },
    };
    h.runtimes.push(value);
    return value;
  };
  return {
    ...(await import("../../../../packages/adapters/src/system/errors")),
    HOST_STATE_DIR: "/root/.openship",
    getPlatform: () => ({ target: "selfhosted", runtime: { name: "docker" } }),
    peekPlatform: () => undefined,
    createExecutor: executor,
    createHostExecutor: executor,
    hostChannelHealth: async () => ({ ok: true, code: "ok" }),
    probeTcp: async () => true,
    invalidateEnvironment: () => {},
    DockerRuntime: { create: () => runtime() },
    createPlatform: async (config: { runtime?: string; executor: { readFile: () => Promise<string> }; localHost?: boolean }) => {
      const sslAction = async (domain: string) => {
        h.sslCalls++;
        if (h.waitForSsl) await h.waitForSsl;
        await config.executor.readFile();
        if (h.failSsl) throw new Error("certificate operation failed");
        return { domain, verified: true, expiresAt: "2030-01-01T00:00:00.000Z", issuer: "test" };
      };
      return {
        target: "selfhosted",
        runtime: await runtime(config.runtime),
        executor: config.executor,
        localHost: config.localHost,
        ssl: { provisionCert: sslAction, renewCert: sslAction, verifyCert: sslAction, installCert: sslAction },
        routing: { serveEdgeChallenge: async () => { await h.infraWork(config.executor); return { served: true }; } },
      };
    },
  };
});

vi.mock("@repo/db", () => {
  const row = (id: string) => ({
    id, organizationId: "org", isLocal: id === "local",
    sshHost: id === "local" ? "127.0.0.1" : "remote.invalid",
    sshUser: "root", sshPort: h.invalidSsh ? 0 : 22, sshAuthMethod: "password", sshPassword: "test-password",
  });
  const verification = {
    id: "target", organizationId: "org", serverId: "remote", target: "http://203.0.113.10",
    host: "203.0.113.10", status: "verified", token: "token", challengePath: "/challenge",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };
  return { repos: {
    server: { get: async (id: string) => row(id), getInOrganization: async (id: string) => row(id) },
    domain: {
      findByHostname: async (hostname: string) => ({
        id: "domain", hostname, projectId: "project", verified: true, domainType: "custom",
      }),
      updateSsl: vi.fn(),
      recordSslFailure: vi.fn(),
    },
    project: { findById: async () => ({ id: "project", organizationId: "org", activeDeploymentId: "deployment" }) },
    deployment: { findById: async () => ({
      id: "deployment", projectId: "project", organizationId: "org",
      meta: { deployTarget: "server", serverId: "remote", runtimeMode: "docker" },
    }), listByProject: async () => ({ rows: [{ organizationId: "org", meta: { deployTarget: "server", serverId: "remote" } }] }) },
    edgeTargetVerification: {
      findByTarget: async () => null,
      recordChallenge: async () => verification,
      recordCheck: vi.fn(async () => {}),
      servableTokens: () => ["token"],
      listAll: async () => [verification, { ...verification, id: "target-2" }],
      recordServeError: vi.fn(),
    },
  } };
});
vi.mock("@repo/platform/engine/lib/box-org", () => ({
  isLocalHostRow: async (row: { isLocal: boolean }) => row.isLocal,
  boxOwningOrgId: async () => "org",
}));
vi.mock("@repo/platform/engine/lib/startup/self-server", () => ({ findLocalServer: async () => null }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({
  cloudClient: () => ({ edgeProxy: {
    requestVerification: async () => ({ id: 1, token: "token", path: "/challenge" }),
    checkVerification: async () => ({ status: "verified" }),
  } }),
  getOrgCloudToken: async () => null,
}));
vi.mock("@repo/platform/engine/lib/cloud/transport", () => ({ resolveOrgCloudUserId: async () => null }));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T>(fn: () => Promise<T>) => fn() }),
}));
vi.mock("@repo/platform/engine/lib/acme-config", () => ({ resolveAcmeProviderOptions: () => ({}) }));
vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", () => ({ resolveDnsManager: vi.fn() }));
vi.mock("@repo/platform/engine/lib/openship-manifest", () => ({
  removeProjectFromManifest: h.infraWork,
  removeProjectSnapshot: async (exec: { readFile: () => Promise<string> }) => { await exec.readFile(); },
}));

import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import * as hostPortTarget from "@repo/platform/engine/lib/host-port-target";
import {
  createServerDockerRuntime,
  resolveDeploymentPlatform,
  resolveDeploymentRuntimeForRead,
  resolveTargetPlatform,
} from "@repo/platform/engine/lib/deployment-runtime";
import {
  installDomainCert,
  manageDomainSsl,
  provisionDomainCertForVerify,
  verifyExistingCert,
} from "@repo/platform/engine/lib/domain-ssl";
import { ensureTargetVerified } from "@repo/platform/engine/lib/edge-target-verify";
import { runEdgeVerifySweep } from "@repo/platform/engine/modules/domains/edge-verify-schedule";
import { removeProjectFromServerManifests } from "@repo/platform/engine/lib/openship-manifest-sync";

const idleWindow = 6 * 60_000;
const advance = () => vi.advanceTimersByTimeAsync(idleWindow);

beforeEach(() => {
  sshManager.invalidate();
  h.executors = [];
  h.runtimes = [];
  h.factoryCalls = 0;
  h.waitForFactory = null;
  h.failDispose = false;
  h.invalidSsh = false;
  h.disposalCalls = 0;
  h.sslCalls = 0;
  h.waitForSsl = null;
  h.failSsl = false;
  h.infraWork.mockReset();
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const runtime of h.runtimes) await runtime.dispose().catch(() => {});
  sshManager.invalidate();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SSL ownership of pooled connections", () => {
  const hostname = "app.example.com";
  const operations = [
    ["provision", () => manageDomainSsl(hostname, { action: "provision" })],
    ["renew", () => manageDomainSsl(hostname, { action: "renew" })],
    ["verify", () => manageDomainSsl(hostname, { action: "verify" })],
    ["verify and issue", () => provisionDomainCertForVerify(hostname, { force: true })],
    ["install", () => installDomainCert(hostname, { certPem: "cert", keyPem: "key" })],
    ["inspect existing", () => verifyExistingCert(hostname)],
  ] as const;

  it.each(operations)("keeps %s connected past the idle window and releases it afterwards", async (_name, run) => {
    let finish!: () => void;
    h.waitForSsl = new Promise<void>((resolve) => { finish = resolve; });
    const pending = run();
    await vi.waitFor(() => expect(h.sslCalls).toBe(1));
    await advance();
    const closedDuringWork = h.executors[0].closed;
    finish();
    await expect(pending).resolves.toMatchObject({ verified: true });
    expect(closedDuringWork).toBe(false);
    await advance();
    expect(h.executors[0].closed).toBe(true);
    expect(h.disposalCalls).toBe(1);
  });

  it.each(operations)("releases %s after failure without replacing the provider error", async (_name, run) => {
    h.failSsl = true;
    await expect(run()).rejects.toThrow("certificate operation failed");
    await advance();
    expect(h.executors[0].closed).toBe(true);
    expect(h.disposalCalls).toBe(1);
  });
});

describe("routing and recovery artifact connection ownership", () => {
  const operations = [
    ["target verification", () => ensureTargetVerified("org", "http://203.0.113.10", { serverId: "remote" })],
    ["cached target sweep", () => runEdgeVerifySweep()],
    ["recovery artifact removal", () => removeProjectFromServerManifests({ id: "project" } as never)],
  ] as const;

  it.each(operations)("keeps %s connected until all its work finishes", async (_name, run) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("token")));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let closedDuringUse = false;
    h.infraWork.mockImplementation(async (exec) => {
      await gate;
      closedDuringUse ||= h.executors[0].closed;
      await exec.readFile();
    });
    const pending = run();
    await vi.waitFor(() => expect(h.infraWork).toHaveBeenCalledOnce());
    await advance();
    const closedWhileWaiting = h.executors[0].closed;
    finish();
    await pending;
    expect(closedWhileWaiting || closedDuringUse).toBe(false);
    expect(h.factoryCalls).toBe(1);
    await advance();
    expect(h.disposalCalls).toBe(1);
    expect(h.executors[0].closed).toBe(true);
  });

  it.each(operations)("releases %s when remote work fails", async (_name, run) => {
    h.infraWork.mockRejectedValue(new Error("remote work failed"));
    await run();
    await advance();
    expect(h.disposalCalls).toBe(1);
    expect(h.executors[0].closed).toBe(true);
  });
});

describe("runtime ownership of pooled connections", () => {
  it.each([
    ["local", "docker"], ["local", "bare"], ["remote", "docker"], ["remote", "bare"],
  ] as const)("keeps a %s %s deployment connected through a long build, then reclaims it", async (serverId, mode) => {
    const platform = await resolveTargetPlatform("server", mode, serverId, "org");
    await advance();
    await expect(h.executors[0].readFile()).resolves.toBeTruthy();
    await platform.runtime.dispose?.();
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it("retains the local host channel even when the deployment has no server row", async () => {
    const platform = await resolveTargetPlatform("local", "bare", undefined, "org");
    await advance();
    expect(h.executors[0].closed).toBe(false);
    await platform.runtime.dispose?.();
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it("releases each borrower once and leaves another deployment connected", async () => {
    const first = await resolveTargetPlatform("server", "docker", "remote", "org");
    const second = await resolveTargetPlatform("server", "docker", "remote", "org");
    expect(h.executors).toHaveLength(1);
    await first.runtime.dispose?.();
    await first.runtime.dispose?.();
    await advance();
    expect(h.executors[0].closed).toBe(false);
    await second.runtime.dispose?.();
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it("holds the connection during platform creation and releases it when creation fails", async () => {
    let reject!: (reason: Error) => void;
    h.waitForFactory = new Promise<void>((_resolve, failure) => { reject = failure; });
    const pending = resolveTargetPlatform("server", "docker", "remote", "org");
    const failed = expect(pending).rejects.toThrow("creation failed");
    await vi.waitFor(() => expect(h.factoryCalls).toBe(1));
    await advance();
    const closedDuringCreation = h.executors[0].closed;
    reject(new Error("creation failed"));
    await failed;
    expect(closedDuringCreation).toBe(false);
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it("releases the borrowed connection even when transport disposal rejects", async () => {
    const platform = await resolveTargetPlatform("server", "docker", "remote", "org");
    await advance();
    expect(h.executors[0].closed).toBe(false);
    h.failDispose = true;
    await expect(platform.runtime.dispose?.()).rejects.toThrow("bridge cleanup failed");
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it("keeps a Docker inspection runtime connected until its caller disposes it", async () => {
    const runtime = await createServerDockerRuntime("remote", "org");
    await advance();
    expect(h.executors[0].closed).toBe(false);
    await runtime.dispose();
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it.each(["deployment", "inspection"])("disposes a %s runtime if host identity resolution fails", async (kind) => {
    // Fail after a valid connection is allocated; invalid SSH input is now
    // rejected earlier and must not bypass this cleanup regression test.
    vi.spyOn(hostPortTarget, "resolveHostPortTargetIdentity")
      .mockRejectedValueOnce(new Error("host identity unavailable"));
    const meta = { deployTarget: "server", serverId: "remote", runtimeMode: "docker" } as const;
    const pending = kind === "deployment"
      ? resolveDeploymentPlatform(meta, { organizationId: "org" })
      : resolveDeploymentRuntimeForRead({ meta, organizationId: "org" } as never);
    await expect(pending).rejects.toThrow("host identity unavailable");
    expect(h.disposalCalls).toBe(1);
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });

  it.each(["deployment", "inspection"])("rejects invalid SSH before allocating a %s runtime", async (kind) => {
    h.invalidSsh = true;
    const meta = { deployTarget: "server", serverId: "remote", runtimeMode: "docker" } as const;
    const pending = kind === "deployment"
      ? resolveDeploymentPlatform(meta, { organizationId: "org" })
      : resolveDeploymentRuntimeForRead({ meta, organizationId: "org" } as never);
    await expect(pending).rejects.toThrow("Invalid SSH host, username or port.");
    expect(h.executors).toHaveLength(0);
    expect(h.runtimes).toHaveLength(0);
  });

  it("does not release a replacement connection when an invalidated runtime finishes", async () => {
    const first = await resolveTargetPlatform("server", "docker", "remote", "org");
    sshManager.invalidate("remote");
    const second = await resolveTargetPlatform("server", "docker", "remote", "org");
    expect(h.executors).toHaveLength(2);
    await first.runtime.dispose?.();
    await advance();
    expect(h.executors[0].closed).toBe(true);
    expect(h.executors[1].closed).toBe(false);
    await second.runtime.dispose?.();
    await advance();
    expect(h.executors[1].closed).toBe(true);
  });

  it("keeps a refreshed connection and its retired predecessor alive for their own borrowers", async () => {
    const first = await resolveTargetPlatform("server", "docker", "remote", "org");
    await sshManager.refreshAuthentication("remote", h.executors[0] as never);
    const second = await resolveTargetPlatform("server", "docker", "remote", "org");
    await advance();
    expect(h.executors.map((executor) => executor.closed)).toEqual([false, false]);
    await first.runtime.dispose?.();
    expect(h.executors[0].closed).toBe(true);
    expect(h.executors[1].closed).toBe(false);
    await second.runtime.dispose?.();
    await advance();
    expect(h.executors[1].closed).toBe(true);
  });

  it("keeps a scoped host command alive for longer than the idle window", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const pending = sshManager.withHostExecutor(async () => work);
    await vi.waitFor(() => expect(h.executors).toHaveLength(1));
    await advance();
    const closedDuringWork = h.executors[0].closed;
    finish();
    await pending;
    expect(closedDuringWork).toBe(false);
    await advance();
    expect(h.executors[0].closed).toBe(true);
  });
});
