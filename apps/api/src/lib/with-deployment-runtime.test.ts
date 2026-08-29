import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `withDeploymentRuntime` — the one entry point every container action (pause,
 * resume, restart, logs, info, usage) now goes through.
 *
 * Its three guarantees are exactly the three things the hand-rolled call sites
 * each got wrong in a different combination, so they're pinned here once instead
 * of per caller:
 *
 *   - the transport is ALWAYS disposed, including when the action throws. The SSH
 *     branch mints a new loopback bridge per runtime, so a missed dispose leaks a
 *     listening socket plus an ssh client per click.
 *   - "couldn't reach the host" becomes a 503 `HOST_UNREACHABLE` carrying the
 *     transport's own reason (a refused key names the target and what to check).
 *   - anything else propagates untouched — a real bug must not be relabelled as
 *     an infrastructure problem.
 */

const h = vi.hoisted(() => ({
  disposed: 0,
  created: 0,
}));

// Only the transport is faked. The error CLASSIFIERS stay real on purpose: they
// are the thing under test here — a stubbed `isRemoteConnectionError` would let
// this suite pass while the mapping it claims to verify did nothing.
vi.mock("@repo/adapters", async () => {
  const actual = await vi.importActual<typeof import("@repo/adapters")>("@repo/adapters");
  return {
    ...actual,
    DockerRuntime: {
      create: async () => {
        h.created += 1;
        return {
          dispose: async () => {
            h.disposed += 1;
          },
        };
      },
    },
  };
});

// Self-hosted base + a snapshot with no serverId → effective target "local",
// which resolves through DockerRuntime.create above with no SSH anywhere.
vi.mock("./controller-helpers", () => ({ platform: () => ({ target: "selfhosted" }) }));

vi.mock("@repo/db", () => ({ repos: { service: { listByDeployment: async () => [] } } }));
vi.mock("./cloud/client", () => ({ cloudClient: {}, getOrgCloudToken: async () => null }));
vi.mock("./cloud/transport", () => ({ resolveOrgCloudUserId: async () => null }));
vi.mock("./ssh-manager", () => ({ buildSshConfig: async () => null, sshManager: {} }));
vi.mock("./provision-lock", () => ({ createProvisionLock: () => ({}) }));
vi.mock("./box-org", () => ({ isLocalHostRow: async () => true }));
vi.mock("./acme-config", () => ({ resolveAcmeProviderOptions: () => ({}) }));

const dep = { meta: {}, organizationId: "org_1" };

describe("withDeploymentRuntime", () => {
  beforeEach(() => {
    h.disposed = 0;
    h.created = 0;
  });

  it("returns the action's value and disposes the transport", async () => {
    const { withDeploymentRuntime } = await import("./deployment-runtime");

    await expect(withDeploymentRuntime(dep, async () => "logs")).resolves.toBe("logs");

    expect(h.created).toBe(1);
    expect(h.disposed).toBe(1);
  });

  it("disposes the transport when the action throws", async () => {
    const { withDeploymentRuntime } = await import("./deployment-runtime");

    await expect(
      withDeploymentRuntime(dep, async () => {
        throw new Error("docker said no");
      }),
    ).rejects.toThrow("docker said no");

    expect(h.disposed).toBe(1);
  });

  it("maps a refused SSH key to 503 HOST_UNREACHABLE, keeping the reason", async () => {
    const { withDeploymentRuntime } = await import("./deployment-runtime");
    const reason =
      "SSH key authentication failed for root@65.109.55.23. Check the username, private key, " +
      "passphrase, or whether the server accepts this key. (All configured authentication methods failed)";

    const err = await withDeploymentRuntime(dep, async () => {
      throw new Error(reason);
    }).catch((e: unknown) => e);

    expect((err as { statusCode?: number }).statusCode).toBe(503);
    expect((err as { code?: string }).code).toBe("HOST_UNREACHABLE");
    expect((err as Error).message).toContain("65.109.55.23");
    expect(h.disposed).toBe(1);
  });

  it.each([
    ["connect ETIMEDOUT 10.0.0.9:22"],
    ["socket hang up"],
    ["Channel open failure: open failed"],
    ["Command timed out after 30000ms"],
  ])("maps transport failure %j to 503", async (message) => {
    const { withDeploymentRuntime } = await import("./deployment-runtime");

    const err = await withDeploymentRuntime(dep, async () => {
      throw new Error(message);
    }).catch((e: unknown) => e);

    expect((err as { statusCode?: number }).statusCode).toBe(503);
  });

  it("leaves an ordinary failure alone — no invented 503", async () => {
    const { withDeploymentRuntime } = await import("./deployment-runtime");

    const err = await withDeploymentRuntime(dep, async () => {
      throw new Error("(HTTP code 404) no such container: abc123");
    }).catch((e: unknown) => e);

    expect((err as { statusCode?: number }).statusCode).toBeUndefined();
    expect((err as Error).message).toContain("no such container");
  });
});

describe("deploymentContainerIds", () => {
  it("prefers the service containers, and falls back to the deployment's own", async () => {
    vi.resetModules();
    vi.doMock("@repo/db", () => ({
      repos: { service: { listByDeployment: async () => [{ containerId: "svc-a" }, { containerId: null }] } },
    }));
    const { deploymentContainerIds } = await import("./deployment-runtime");

    expect(await deploymentContainerIds({ id: "dep_1", containerId: "app" })).toEqual(["svc-a"]);

    vi.resetModules();
    vi.doMock("@repo/db", () => ({ repos: { service: { listByDeployment: async () => [] } } }));
    const fresh = await import("./deployment-runtime");
    expect(await fresh.deploymentContainerIds({ id: "dep_1", containerId: "app" })).toEqual(["app"]);
    expect(await fresh.deploymentContainerIds({ id: "dep_1", containerId: null })).toEqual([]);
  });
});
