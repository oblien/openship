import { describe, expect, it } from "vitest";

import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";

/**
 * What a compose service's hardening becomes at container create (#749).
 *
 * The unit rules for each field are the authority module's
 * (packages/core/src/compose-hardening.test.ts) and the end-to-end proof is
 * `apps/api/test/e2e/compose-hardening.e2e.test.ts`, which asserts a real
 * container's shape through a real inspect. What is only provable HERE is the
 * seam between them: that the create payload carries the controls at all, into
 * the two DIFFERENT blocks Docker reads them from, and that an unhardened service
 * leaves no key behind.
 *
 * That last one is the case that can silently go wrong. These are spread into the
 * payload, and `ReadonlyRootfs: undefined` is still a key the Engine reads, so a
 * conditional that emitted the key with an undefined value would look correct in
 * a diff and behave differently at the daemon. Same trap `Entrypoint` and
 * `toStopConfig` already carry their own guards for.
 */

const GROUP: MultiServiceGroupHandle = { id: "net-openship-demo" } as MultiServiceGroupHandle;

function baseConfig(overrides: Partial<MultiServiceDeployConfig> = {}): MultiServiceDeployConfig {
  return {
    deploymentId: "dep-1",
    projectId: "proj-1",
    slug: "demo",
    serviceName: "app",
    image: "openship/local:app",
    ports: [],
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    ...overrides,
  } as MultiServiceDeployConfig;
}

/** A daemon that records the create payload and reports a bare running container. */
function recordingDaemon() {
  const creates: Array<Record<string, any>> = [];
  const docker = {
    getContainer: () => ({ remove: async () => undefined }),
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

async function createWith(config: MultiServiceDeployConfig) {
  const { docker, creates } = recordingDaemon();
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  await runtime.deployServiceWorkload(GROUP, config);
  return creates[0]!;
}

describe("deployServiceWorkload: container hardening", () => {
  it("splits the five across Config.User and HostConfig, as the Engine reads them", async () => {
    const args = await createWith(
      baseConfig({
        advanced: {
          user: "1000:1000",
          readOnly: true,
          capDrop: ["ALL"],
          securityOpt: ["no-new-privileges:true", "apparmor:openship"],
          tmpfs: ["/run:size=64m,mode=1777", "/tmp"],
        },
      }),
    );
    expect(args.User).toBe("1000:1000");
    expect(args.HostConfig.ReadonlyRootfs).toBe(true);
    expect(args.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(args.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true", "apparmor:openship"]);
    expect(args.HostConfig.Tmpfs).toEqual({ "/run": "size=64m,mode=1777", "/tmp": "" });
  });

  it("sends no hardening key at all for a service that declared none", async () => {
    const args = await createWith(baseConfig());
    expect("User" in args).toBe(false);
    for (const key of ["ReadonlyRootfs", "CapDrop", "SecurityOpt", "Tmpfs"]) {
      expect(key in args.HostConfig).toBe(false);
    }
  });

  /**
   * Hardening rides on the same `advanced` blob as the namespaces and the stop
   * behaviour, all spread into one payload. A service using both must get both:
   * a draft that assigned rather than spread lost whichever came second.
   */
  it("applies hardening alongside a shared namespace and a stop signal", async () => {
    const args = await createWith(
      baseConfig({
        namespaces: { network: "container:abcdef123456" },
        advanced: {
          readOnly: true,
          capDrop: ["ALL"],
          stopSignal: "SIGQUIT",
          networkMode: "container:abcdef123456",
        },
      }),
    );
    expect(args.HostConfig.NetworkMode).toBe("container:abcdef123456");
    expect(args.StopSignal).toBe("SIGQUIT");
    expect(args.HostConfig.ReadonlyRootfs).toBe(true);
    expect(args.HostConfig.CapDrop).toEqual(["ALL"]);
  });
});
