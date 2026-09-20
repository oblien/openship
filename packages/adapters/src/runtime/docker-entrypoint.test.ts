import { describe, expect, it } from "vitest";

import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";

/**
 * What a compose `entrypoint:` becomes at container create (#575).
 *
 * Pinned at the payload rather than at the resolver because the bug is entirely
 * about the difference between a key being ABSENT and a key being `[]`. Docker
 * treats `Entrypoint: []` as "clear the image's ENTRYPOINT" and an absent key as
 * "keep it", so a resolver that returns the right value is still wrong if the
 * caller assigns `undefined` into the payload — the key would be present.
 *
 * Same recording-daemon shape as docker-namespaces.test.ts, for the same reason:
 * this is the create call, and the only way to know what Docker was told is to
 * look at what was passed.
 */

const GROUP: MultiServiceGroupHandle = { id: "net-openship-demo" } as MultiServiceGroupHandle;

function baseConfig(overrides: Partial<MultiServiceDeployConfig> = {}): MultiServiceDeployConfig {
  return {
    deploymentId: "dep-1",
    projectId: "proj-1",
    slug: "demo",
    serviceName: "app",
    image: "ghcr.io/goauthentik/server:latest",
    ports: ["9000:9000"],
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

describe("deployServiceWorkload — entrypoint (#575)", () => {
  // The regression. Before this, an entrypoint was parsed, warned about, and dropped;
  // the image's own launcher ran and got the command as arguments.
  it("sends an override as argv", async () => {
    const args = await createWith(
      baseConfig({ advanced: { entrypoint: ["/custom-init.sh", "--verbose"] } }),
    );
    expect(args.Entrypoint).toEqual(["/custom-init.sh", "--verbose"]);
  });

  // The issue's real-world shape: clear the wrapper, then run the binary directly.
  it("sends an EMPTY Entrypoint for the clearing form, alongside the command", async () => {
    const args = await createWith(
      baseConfig({
        advanced: { entrypoint: [] },
        commandArgv: ["/app/bin/thing", "--flag"],
      }),
    );
    expect(args.Entrypoint).toEqual([]);
    // The key has to be PRESENT — an absent one means "keep the image's".
    expect("Entrypoint" in args).toBe(true);
    // And the command still overrides CMD as argv, no `sh -c` (#332).
    expect(args.Cmd).toEqual(["/app/bin/thing", "--flag"]);
  });

  // The other half of the same distinction, and the one an `Entrypoint: undefined`
  // assignment would break: no entrypoint recorded ⇒ the key must not be sent at all.
  it("omits the key entirely when no entrypoint is recorded", async () => {
    const args = await createWith(baseConfig());
    expect("Entrypoint" in args).toBe(false);
  });

  it("omits it for a legacy row whose advanced blob predates the field", async () => {
    const args = await createWith(baseConfig({ advanced: { stopSignal: "SIGQUIT" } }));
    expect("Entrypoint" in args).toBe(false);
    // ...while the sibling advanced key it DOES carry still lands.
    expect(args.StopSignal).toBe("SIGQUIT");
  });
});
