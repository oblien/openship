import type { SwarmInspection } from "../src/server-swarm";

export const swarmFixture = (): SwarmInspection => ({
  state: "active",
  role: "manager",
  nodeId: "node-a",
  clusterId: "cluster-a",
  nodeCount: 1,
  managerCount: 1,
  observedAt: "2026-10-21T00:00:00.000Z",
  inventory: {
    nodes: [
      {
        id: "node-a",
        name: "manager",
        role: "manager",
        state: "ready",
        availability: "active",
        leader: true,
      },
    ],
    stacks: [
      {
        name: "shop",
        services: [
          {
            id: "service-a",
            name: "shop_web",
            image: "nginx:1.28",
            mode: "replicated",
            runningTasks: 1,
            desiredTasks: 2,
            updateState: null,
            ports: [],
            mounts: [],
          },
        ],
      },
    ],
  },
});
