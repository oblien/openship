import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type Dockerode from "dockerode";
import { BuildLogger } from "../build-pipeline";
import { runDeployPipeline } from "../deploy-pipeline";
import type { DockerRuntime } from "../docker";
import { SwarmRuntime } from "./runtime";

/** Model a create which may commit after the client's response deadline. */
describe("Swarm uncertain activation recovery", () => {
  it.each(["lost", "malformed", "rejected"])(
    "recovers only after a definite create rejection (%s receipt)",
    async (receipt) => {
      const projectId = "project",
        runtimeId = "runtime";
      const oldId = "a".repeat(25);
      const image = `busybox@sha256:${"b".repeat(64)}`;
      const labels = {
        "openship.project": projectId,
        "openship.runtime": runtimeId,
        "openship.scheduler": "swarm",
        "openship.service": "worker",
        "openship.replicas": "1",
        "openship.aliases": '["worker"]',
      };
      let createDispatched = false;
      const updatePrevious = vi.fn();
      const docker = {
        modem: {
          dial: (
            request: { path: string; method: string },
            callback: (error: Error | null, body?: unknown) => void,
          ) => {
            if (request.path === "/info")
              return callback(null, {
                Swarm: {
                  LocalNodeState: "active",
                  ControlAvailable: true,
                  NodeID: "manager",
                  Cluster: { ID: "cluster" },
                },
              });
            if (request.path.startsWith("/services?")) return callback(null, []);
            if (request.path === `/services/${oldId}`)
              return callback(null, {
                ID: oldId,
                Version: { Index: 1 },
                Spec: {
                  Name: "previous",
                  Labels: labels,
                  Mode: { Replicated: { Replicas: 0 } },
                  TaskTemplate: { ContainerSpec: { Image: image }, Networks: [] },
                },
              });
            if (request.path === "/services/create") {
              createDispatched = true;
              if (receipt === "rejected")
                return callback(
                  Object.assign(new Error("invalid service specification"), { statusCode: 400 }),
                );
              return receipt === "lost"
                ? callback(Object.assign(new Error("create response lost"), { code: "ETIMEDOUT" }))
                : callback(null, { ID: "invalid" });
            }
            if (request.path.startsWith(`/services/${oldId}/update`)) {
              updatePrevious();
              return callback(new Error("The old writer must not be restarted"));
            }
            return callback(new Error(`Unexpected request: ${request.method} ${request.path}`));
          },
        },
        getImage: () => ({
          inspect: async () => ({ Architecture: "amd64", Os: "linux", Config: {} }),
        }),
        getNetwork: () => ({
          inspect: async () => ({
            Id: "network",
            Driver: "overlay",
            Attachable: true,
            Options: { encrypted: "" },
            Labels: labels,
          }),
        }),
      } as unknown as Dockerode;
      const runtime = new SwarmRuntime({
        projectId,
        runtimeId,
        clusterUid: "cluster",
        managerNodeId: "manager",
        config: { replicas: 1 },
        resolveRegistryAuth: async () => undefined,
        builder: async () =>
          ({
            docker,
            prepareImage: async () => ({ status: "success", imageRef: image }),
            dispose: async () => undefined,
          }) as unknown as DockerRuntime,
      });
      const logger = new BuildLogger(() => {});
      const service = {
        projectId,
        deploymentId: "candidate",
        slug: "app",
        serviceName: "worker",
        image,
        ports: [],
        environment: {},
        volumes: [],
        namespaceVolumes: true,
      };
      const oldRef = `swarm:${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}:${oldId}`;
      try {
        const result = await runDeployPipeline(
          {
            canOverlap: false,
            preflight: () => runtime.prepareServiceWorkload(service),
            activate: () => runtime.deployServiceWorkload({ id: "network" }, service),
            deactivate: vi.fn(),
            deactivateRetaining: vi.fn(),
            reactivatePrevious: (id) => runtime.start(id),
          },
          {
            previousContainerId: oldRef,
            domains: [],
            config: {
              projectId,
              deploymentId: "candidate",
              buildSessionId: "candidate",
              environment: "production",
              port: 8080,
              envVars: {},
              resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
            },
          },
          logger,
        );
        expect(createDispatched).toBe(true);
        expect(result.status).toBe("failed");
        if (receipt === "rejected") {
          expect(updatePrevious).toHaveBeenCalledOnce();
        } else {
          expect(updatePrevious).not.toHaveBeenCalled();
          await expect(runtime.start(oldRef)).rejects.toMatchObject({
            code: "CLUSTER_ROLLOUT_UNCERTAIN",
          });
        }
      } finally {
        await runtime.dispose();
      }
    },
  );
});
