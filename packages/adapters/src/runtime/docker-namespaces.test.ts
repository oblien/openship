import { describe, expect, it } from "vitest";

import { DockerRuntime } from "./docker";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";

/**
 * What a compose `network_mode` / `pid` becomes at container create (#533).
 *
 * The sharing itself is one HostConfig line. What needs pinning is the
 * SUPPRESSION: Docker does not ignore a port binding, a network endpoint, or an
 * explicit hostname alongside `NetworkMode: container:…` — each one fails the
 * create outright. So a service that shares a sibling's netns must be built
 * WITHOUT them, and a regression here doesn't produce a subtly-wrong container,
 * it produces a deploy that cannot start at all.
 *
 * `none` is the near-miss worth its own case: it is not sharing (the container
 * keeps its own empty namespace, and so its own hostname), but it still must not
 * be handed a project-network endpoint that would contradict it.
 */

const GROUP: MultiServiceGroupHandle = { id: "net-openship-demo" } as MultiServiceGroupHandle;

function baseConfig(overrides: Partial<MultiServiceDeployConfig> = {}): MultiServiceDeployConfig {
  return {
    deploymentId: "dep-1",
    projectId: "proj-1",
    slug: "demo",
    serviceName: "app",
    image: "openship/local:app",
    ports: ["8080:80"],
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    extraAliases: ["web"],
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

describe("deployServiceWorkload — shared namespaces", () => {
  it("puts a normal service on the project network, with ports, alias, and hostname", async () => {
    const args = await createWith(baseConfig());
    expect(args.HostConfig.NetworkMode).toBe(GROUP.id);
    expect(args.HostConfig.PortBindings).toBeTruthy();
    expect(args.Hostname).toBe("app");
    expect(args.NetworkingConfig.EndpointsConfig[GROUP.id].Aliases).toEqual(["app", "web"]);
    expect(args.HostConfig.PidMode).toBeUndefined();
  });

  it("shares a sibling's netns and drops everything Docker would refuse alongside it", async () => {
    const args = await createWith(
      baseConfig({ namespaces: { network: "container:abcdef123456" } }),
    );
    expect(args.HostConfig.NetworkMode).toBe("container:abcdef123456");
    // Each of these three is a create-time error when NetworkMode is a container.
    expect(args.HostConfig.PortBindings).toBeUndefined();
    expect(args.ExposedPorts).toBeUndefined();
    expect(args.Hostname).toBeUndefined();
    expect(args.NetworkingConfig).toBeUndefined();
  });

  it("shares a PID namespace without giving up its own networking", async () => {
    // The asymmetry that makes `pid` cheap: it costs the container nothing else.
    const args = await createWith(baseConfig({ namespaces: { pid: "container:abcdef123456" } }));
    expect(args.HostConfig.PidMode).toBe("container:abcdef123456");
    expect(args.HostConfig.NetworkMode).toBe(GROUP.id);
    expect(args.HostConfig.PortBindings).toBeTruthy();
    expect(args.Hostname).toBe("app");
    expect(args.NetworkingConfig.EndpointsConfig[GROUP.id].Aliases).toEqual(["app", "web"]);
  });

  it("applies both at once", async () => {
    const args = await createWith(
      baseConfig({ namespaces: { network: "container:aaa", pid: "container:bbb" } }),
    );
    expect(args.HostConfig.NetworkMode).toBe("container:aaa");
    expect(args.HostConfig.PidMode).toBe("container:bbb");
    expect(args.NetworkingConfig).toBeUndefined();
  });

  it("network_mode: none keeps its hostname but is never attached to a network", async () => {
    const args = await createWith(baseConfig({ namespaces: { network: "none" } }));
    expect(args.HostConfig.NetworkMode).toBe("none");
    // Attaching an endpoint would contradict the mode; publishing reaches nothing.
    expect(args.NetworkingConfig).toBeUndefined();
    expect(args.HostConfig.PortBindings).toBeUndefined();
    expect(args.Hostname).toBe("app");
  });

  it("treats `none` and `container:` identically for ports and endpoints", async () => {
    // The pair the deploy path also has to agree with: whichever mode is declared,
    // there is no address, so nothing is published and nothing is attached. Asking
    // this question two different ways is what gave a `none` service a pinned
    // loopback port and a live route to a container that publishes nothing.
    const none = await createWith(baseConfig({ namespaces: { network: "none" } }));
    const shared = await createWith(baseConfig({ namespaces: { network: "container:abc" } }));
    for (const args of [none, shared]) {
      expect(args.HostConfig.PortBindings).toBeUndefined();
      expect(args.ExposedPorts).toBeUndefined();
      expect(args.NetworkingConfig).toBeUndefined();
    }
  });

  it("still mounts volumes and honors restart policy when sharing", async () => {
    // Sharing a namespace says nothing about storage — a regression that dropped
    // Binds along with the ports would silently deploy a stateful sidecar empty.
    const args = await createWith(
      baseConfig({
        volumes: ["/host/conf:/etc/conf:ro"],
        restart: "always",
        namespaces: { network: "container:abc" },
      }),
    );
    expect(args.HostConfig.Binds).toEqual(["/host/conf:/etc/conf:ro"]);
    expect(args.HostConfig.RestartPolicy.Name).toBe("always");
  });
});
