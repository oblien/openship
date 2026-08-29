/**
 * A service with a live container is backed up THROUGH the container, whatever the
 * deployment snapshot claims.
 *
 * [#611](https://github.com/oblien/openship/issues/611)'s root cause. The control
 * plane's own project is a Docker compose stack, but its adopt deployment is stamped
 * `runtimeMode: "bare"` — accurately, for what that adopt did (it health-probed a
 * port with BareRuntime and never started a container). Both orchestrators read the
 * executor straight off that field, so a policy on its `postgres` service got the
 * BARE executor: `listSources()` can then only read the service row's `volumes`
 * column, which is empty for rows built from containers, and `execStream` runs on
 * the host, where there is no `pg_dump`.
 *
 * The override is deliberately narrow, and the narrowing is what these tests are
 * mostly about: only `bare` is ever upgraded, and only after the daemon confirms the
 * container exists — because a genuinely bare deployment can carry a `containerId`
 * that is a pid or a deployment id, and acting on that would break a working setup
 * to fix a broken one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Runtime name the snapshot resolves to. */
  snapshotRuntime: "bare",
  /** Container ids the docker probe's host reports. */
  hostContainers: [] as string[],
  /** Make the docker-mode resolution throw (no daemon, no permission). */
  dockerResolveError: null as string | null,
  /** Runtimes handed to disposeRuntime, so ownership is observable. */
  disposed: [] as string[],
  /** Runtime names resolveExecutor was asked for. */
  executorsFor: [] as string[],
  /** Every meta resolveDeploymentPlatform saw. */
  resolvedWith: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  disposeRuntime: (r: { name?: string } | null | undefined) => {
    if (r?.name) h.disposed.push(r.name);
  },
  resolveDeploymentPlatform: async (meta: Record<string, unknown>) => {
    h.resolvedWith.push(meta ?? {});
    const wantsDocker = meta?.runtimeMode === "docker";
    if (wantsDocker) {
      if (h.dockerResolveError) throw new Error(h.dockerResolveError);
      return {
        platform: {
          runtime: {
            name: "docker",
            supports: (cap: string) => cap === "hostContainerQuery",
            listAllContainers: async () => h.hostContainers.map((id) => ({ id })),
          },
        },
      };
    }
    return {
      platform: {
        runtime: {
          name: h.snapshotRuntime,
          supports: () => false,
        },
      },
    };
  },
}));

vi.mock("@repo/adapters", () => ({
  resolveExecutor: (name: string) => {
    h.executorsFor.push(name);
    return { runtimeName: name };
  },
}));

import { resolveSourceExecutor } from "../../../src/modules/backups/source-platform";

const call = (over: Partial<Parameters<typeof resolveSourceExecutor>[0]> = {}) =>
  resolveSourceExecutor({
    meta: { deployTarget: "local", runtimeMode: "bare", adopt: true },
    organizationId: "org_1",
    containerId: "c_pg_full_id",
    serviceName: "postgres",
    ...over,
  });

beforeEach(() => {
  h.snapshotRuntime = "bare";
  h.hostContainers = [];
  h.dockerResolveError = null;
  h.disposed.length = 0;
  h.executorsFor.length = 0;
  h.resolvedWith.length = 0;
});

describe("bare snapshot + a real container = the docker executor", () => {
  it("upgrades when the daemon confirms the container exists", async () => {
    h.hostContainers = ["c_pg_full_id"];

    const out = await call();

    expect(out.runtime.name).toBe("docker");
    expect(out.executor.runtimeName).toBe("docker");
    // The bare runtime we are not using is released, not leaked.
    expect(h.disposed).toEqual(["bare"]);
  });

  it("asks for the same target, changing only the runtime mode", async () => {
    // The probe must not invent a different target — a remote server's containers
    // live on that server, and resolving `local` would look at the wrong host.
    h.hostContainers = ["c_pg_full_id"];

    await call({ meta: { deployTarget: "server", serverId: "srv_9", runtimeMode: "bare" } });

    expect(h.resolvedWith[1]).toMatchObject({
      deployTarget: "server",
      serverId: "srv_9",
      runtimeMode: "docker",
    });
  });

  it("matches a short recorded id against the daemon's full one", async () => {
    h.hostContainers = ["abcdef0123456789abcdef"];

    const out = await call({ containerId: "abcdef012345" });

    expect(out.runtime.name).toBe("docker");
  });
});

describe("the override refuses to guess", () => {
  it("keeps bare when the daemon does not know the container", async () => {
    // A genuinely bare deployment: `containerId` is a pid or a deployment id, not a
    // container. Upgrading on the id alone would break a working bare backup.
    h.hostContainers = ["something_else"];

    const out = await call();

    expect(out.runtime.name).toBe("bare");
    expect(out.executor.runtimeName).toBe("bare");
    // The probe runtime is the one released here.
    expect(h.disposed).toEqual(["docker"]);
  });

  it("keeps bare when the service has no container at all", async () => {
    const out = await call({ containerId: null });

    expect(out.runtime.name).toBe("bare");
    // No probe was even attempted — one resolution, not two.
    expect(h.resolvedWith).toHaveLength(1);
  });

  it("never overrides a cloud runtime", async () => {
    // Cloud has its own executor and its own container semantics; a container id
    // there is not an invitation to reach for a Docker daemon.
    h.snapshotRuntime = "cloud";
    h.hostContainers = ["c_pg_full_id"];

    const out = await call();

    expect(out.runtime.name).toBe("cloud");
    expect(h.resolvedWith).toHaveLength(1);
  });

  it("leaves a docker snapshot alone rather than resolving twice", async () => {
    h.snapshotRuntime = "docker";

    const out = await call();

    expect(out.runtime.name).toBe("docker");
    expect(h.resolvedWith).toHaveLength(1);
  });

  it("falls back to bare — never throws — when the probe cannot resolve", async () => {
    // No reachable daemon is the snapshot's answer anyway. A backup must not fail
    // because an optional probe did.
    h.dockerResolveError = "Cannot connect to the Docker daemon";

    const out = await call();

    expect(out.runtime.name).toBe("bare");
    expect(out.executor.runtimeName).toBe("bare");
  });
});
