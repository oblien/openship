import { createServer, type Server } from "node:http";
import Dockerode from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDockerSwarm } from "./inspect";

let server: Server;
let docker: Dockerode;
let calls: string[];
let responses: Record<string, { status?: number; body: unknown }>;
beforeEach(async () => {
  calls = [];
  responses = {
    "/info": {
      body: {
        Swarm: {
          LocalNodeState: "active",
          ControlAvailable: true,
          NodeID: "node-a",
          Cluster: { ID: "cluster-a", JoinTokens: { Worker: "secret-token" } },
          Nodes: 2,
          Managers: 1,
        },
      },
    },
    "/services?status=true": {
      body: [
        {
          ID: "svc-a",
          Spec: {
            Name: "shop_web",
            Labels: { "com.docker.stack.namespace": "shop", secret: "private-label" },
            Mode: { Replicated: { Replicas: 2 } },
            TaskTemplate: {
              ContainerSpec: {
                Image: "nginx:1.28@sha256:abc",
                Env: ["PASSWORD=secret-env"],
                Args: ["secret-arg"],
                Secrets: [{ SecretName: "private-secret" }],
                Mounts: [
                  { Type: "volume", Source: "private-volume", Target: "/data", ReadOnly: true },
                ],
              },
            },
            EndpointSpec: { Ports: [{ Protocol: "tcp", TargetPort: 80, PublishedPort: 0 }] },
          },
          Endpoint: {
            Ports: [
              { Protocol: "tcp", TargetPort: 80, PublishedPort: 30001, PublishMode: "ingress" },
            ],
          },
          ServiceStatus: { RunningTasks: 1, DesiredTasks: 2 },
          UpdateStatus: { State: "paused" },
        },
      ],
    },
    "/nodes": {
      body: [
        {
          ID: "node-a",
          Description: { Hostname: "manager-a" },
          Spec: { Role: "manager", Availability: "active" },
          Status: { State: "ready", Addr: "private-address" },
          ManagerStatus: { Leader: true, Addr: "private-manager-address" },
        },
      ],
    },
  };
  server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const reply = responses[req.url!.replace(/^\/v1\.47/, "")];
    res.writeHead(reply?.status ?? (reply ? 200 : 404), { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply?.body ?? { message: "Unexpected request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test socket");
  docker = new Dockerode({ host: "127.0.0.1", port: address.port, version: "v1.47" });
});
afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("read-only Swarm inventory over the Docker API", () => {
  it("uses versioned GET requests and returns scheduler observations without private configuration", async () => {
    const result = await inspectDockerSwarm(docker, true);
    expect(calls.sort()).toEqual([
      "GET /v1.47/info",
      "GET /v1.47/nodes",
      "GET /v1.47/services?status=true",
    ]);
    expect(result).toMatchObject({
      state: "active",
      role: "manager",
      clusterId: "cluster-a",
      nodeCount: 2,
      inventory: {
        nodes: [{ name: "manager-a", leader: true }],
        stacks: [
          {
            name: "shop",
            services: [
              {
                name: "shop_web",
                runningTasks: 1,
                desiredTasks: 2,
                updateState: "paused",
                ports: [{ published: 30001, target: 80 }],
                mounts: [{ type: "volume", target: "/data", readOnly: true }],
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-|Env|Args|JoinTokens|Source/);
  });

  it.each(["inactive", "pending", "locked", "error", "new-unknown-state"])(
    "does not query a manager when state is %s",
    async (state) => {
      responses["/info"] = { body: { Swarm: { LocalNodeState: state } } };
      expect(await inspectDockerSwarm(docker, true)).toMatchObject({
        state: state === "new-unknown-state" ? "unknown" : state,
        inventory: null,
      });
      expect(calls).toEqual(["GET /v1.47/info"]);
    },
  );

  it("does not follow worker manager addresses, and keeps detection cheap on managers", async () => {
    await inspectDockerSwarm(docker);
    responses["/info"] = {
      body: {
        Swarm: {
          LocalNodeState: "active",
          ControlAvailable: false,
          NodeID: "worker",
          RemoteManagers: [{ Addr: "private-manager:2377" }],
        },
      },
    };
    expect(await inspectDockerSwarm(docker, true)).toMatchObject({
      role: "worker",
      clusterId: null,
      managerCount: null,
      inventory: null,
    });
    expect(calls).toEqual(["GET /v1.47/info", "GET /v1.47/info"]);
  });

  it("keeps global/standalone services and unknown replica counts distinct from zero", async () => {
    responses["/services?status=true"] = {
      body: [{ ID: "svc-global", Spec: { Name: "agent", Mode: { Global: {} }, TaskTemplate: {} } }],
    };
    expect((await inspectDockerSwarm(docker, true)).inventory?.stacks).toMatchObject([
      { name: null, services: [{ mode: "global", desiredTasks: null, runningTasks: null }] },
    ]);
  });

  it("surfaces demotion, partial failure and malformed inventory instead of reporting an empty cluster", async () => {
    responses["/nodes"] = { status: 503, body: { message: "not a swarm manager" } };
    await expect(inspectDockerSwarm(docker, true)).rejects.toThrow("not a swarm manager");
    responses["/nodes"] = { body: {} };
    await expect(inspectDockerSwarm(docker, true)).rejects.toMatchObject({
      code: "SWARM_INSPECTION_INVALID",
    });
  });

  it("aborts a hung request and removes its deadline timer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hung = {
      modem: {
        dial: (options: { abortSignal: AbortSignal }) => {
          signal = options.abortSignal;
        },
      },
    } as unknown as Dockerode;
    const pending = expect(inspectDockerSwarm(hung)).rejects.toMatchObject({
      code: "SWARM_INSPECTION_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
