import { describe, expect, it, vi } from "vitest";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import type { SwarmStack } from "@repo/db";
import { createSwarmOperationsService } from "./swarm-operations.service";

const stack = {
  id: "swarm-blog",
  projectId: "project-blog",
  organizationId: "org-a",
  managerServerId: "server-a",
  clusterId: "cluster-a",
  stackName: "blog",
  managementMode: "managed",
  sourceKind: "inline",
  sourceStatus: "valid",
  sourceVersion: 1,
  sourceYamlEnc: "services:\n  web:\n    image: nginx:1.27-alpine\n    environment:\n      API_TOKEN: test-secret-token\n",
} as unknown as SwarmStack;

function snapshot(mode: "replicated" | "global" | "replicated-job" = "replicated"): SwarmDiscoverySnapshot {
  return {
    manager: { engineVersion: "27", apiVersion: "1.47", localNodeState: "active", controlAvailable: true, clusterId: "cluster-a", nodeId: "node-a", nodeAddress: null, managerAddress: null },
    nodes: [{ id: "node-a", hostname: "manager", status: "ready", availability: "active", managerStatus: "leader", engineVersion: "27", labels: {} }],
    stacks: [{ name: "blog", serviceIds: ["svc-web"], serviceNames: ["web"] }],
    services: [{
      id: "svc-web", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 3,
      mode, desiredReplicas: mode === "replicated" ? 1 : null, image: "nginx:1.27-alpine", loggingDriver: "json-file",
      labels: { "com.openship.stack-id": "swarm-blog", "com.openship.project-id": "project-blog" },
      endpointMode: null, placement: null, resources: null, updateConfig: null, rollbackConfig: null,
      restartPolicy: null, networks: [], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null,
    }],
    tasks: [], networks: [], volumes: [], configs: [], secrets: [], diagnostics: [], observedAt: "2026-07-30T00:00:00.000Z",
  };
}

function fixture(options: { mode?: "replicated" | "global" | "replicated-job"; stackOverride?: SwarmStack; stackOwnedPersistentObject?: boolean; responseLostAfterRemove?: boolean } = {}) {
  const activeStack = options.stackOverride ?? stack;
  const scaleService = vi.fn(async () => ({ output: "blog_web scaled" }));
  const restartService = vi.fn(async () => ({ output: "blog_web restarted" }));
  const getServiceLogs = vi.fn(async () => ({ entries: [{ raw: "blog_web.1.task-web@manager | 2026-07-30T00:00:00.000000000Z token=test-secret-token started", timestamp: "2026-07-30T00:00:00.000000000Z", message: "token=test-secret-token started", serviceName: "blog_web", taskId: "task-web", nodeName: "manager" }] }));
  const streamServiceLogs = vi.fn((_input, onEntry) => {
    onEntry({ raw: "blog_web.1.task-web@manager | 2026-07-30T00:00:01.000000000Z Authorization bearer-value connected", timestamp: "2026-07-30T00:00:01.000000000Z", message: "Authorization bearer-value connected", serviceName: "blog_web", taskId: "task-web", nodeName: "manager" });
    return { done: Promise.resolve(), stop: vi.fn() };
  });
  let removed = false;
  const removeStack = vi.fn(async () => {
    removed = true;
    if (options.responseLostAfterRemove) throw new Error("connection lost after manager accepted stack removal");
    return { output: "Removing service blog_web" };
  });
  const updateSource = vi.fn(async () => activeStack);
  const refresh = vi.fn(async () => ({ status: "drifted" }));
  const discovery = snapshot(options.mode);
  if (options.stackOwnedPersistentObject) {
    discovery.secrets = [{ id: "secret-1", name: "blog_db_password", labels: { "com.docker.stack.namespace": "blog" }, createdAt: null }];
  }
  const updateStack = vi.fn();
  const service = createSwarmOperationsService({
    featureEnabled: () => true,
    getStack: async () => activeStack,
    resolvePlatform: async () => ({
      stackRuntime: {
        discover: async () => removed ? { ...discovery, stacks: [], services: [], tasks: [] } : discovery,
        scaleService,
        restartService,
        getServiceLogs,
        streamServiceLogs,
        removeStack,
      },
    } as never),
    waitForConvergence: async () => ({ status: "ready", snapshot: discovery, health: { stackName: "blog", state: "ready", services: [], diagnostics: [] }, attempts: 1 }),
    updateSource,
    refresh,
    updateStack,
    getProject: async () => ({ id: "project-blog", activeDeploymentId: "deployment-1" } as never),
    updateDeploymentStatus: vi.fn(),
  });
  return { service, scaleService, restartService, getServiceLogs, streamServiceLogs, removeStack, updateSource, refresh, updateStack };
}

describe("managed Swarm service scaling", () => {
  it("scales an owned replicated service to zero as explicit operational drift", async () => {
    const test = fixture();
    await expect(test.service.scale({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web", replicas: 0, persistence: "temporary",
    })).resolves.toMatchObject({ state: "ready", replicas: 0, persistence: "temporary", sourcePersisted: false });
    expect(test.scaleService).toHaveBeenCalledWith({ serviceId: "svc-web", replicas: 0 });
    expect(test.updateSource).not.toHaveBeenCalled();
    expect(test.refresh).toHaveBeenCalledWith("project-blog", "org-a");
  });

  it("can persist a successful scale into the authoritative inline source", async () => {
    const test = fixture();
    await expect(test.service.scale({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web", replicas: 3, persistence: "inline-source",
    })).resolves.toMatchObject({ sourcePersisted: true, replicas: 3 });
    expect(test.updateSource).toHaveBeenCalledWith(stack, expect.objectContaining({
      inlineYaml: expect.stringContaining("replicas: 3"),
    }));
  });

  it.each<["global" | "replicated-job", string]>([
    ["global", "SWARM_SERVICE_SCALE_GLOBAL"],
    ["replicated-job", "SWARM_SERVICE_SCALE_JOB"],
  ])("rejects %s services with a scheduler-specific explanation", async (mode, code) => {
    const test = fixture({ mode });
    await expect(test.service.scale({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web", replicas: 2, persistence: "temporary",
    })).rejects.toMatchObject({ code, statusCode: 409 });
    expect(test.scaleService).not.toHaveBeenCalled();
  });

  it("force-restarts an owned service without changing its durable service identity", async () => {
    const test = fixture();
    await expect(test.service.restart({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web",
    })).resolves.toMatchObject({ serviceId: "svc-web", state: "ready", output: "blog_web restarted" });
    expect(test.restartService).toHaveBeenCalledWith({ serviceId: "svc-web" });
    expect(test.refresh).toHaveBeenCalledWith("project-blog", "org-a");
  });

  it("does not force-restart a job service", async () => {
    const test = fixture({ mode: "replicated-job" });
    await expect(test.service.restart({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web",
    })).rejects.toMatchObject({ code: "SWARM_SERVICE_RESTART_JOB", statusCode: 409 });
    expect(test.restartService).not.toHaveBeenCalled();
  });

  it("reads manager service logs while redacting source-known and common credential values", async () => {
    const test = fixture();
    await expect(test.service.logs({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web", tail: 20,
    })).resolves.toMatchObject({
      serviceName: "web",
      loggingDriver: "json-file",
      entries: [{ message: "token=[REDACTED] started", level: "info" }],
    });
    expect(test.getServiceLogs).toHaveBeenCalledWith(expect.objectContaining({ serviceId: "svc-web", tail: 20 }));
  });

  it("streams sanitized service logs and supports a caller-owned stop handle", async () => {
    const test = fixture();
    const entries: unknown[] = [];
    const stream = await test.service.streamLogs({
      projectId: "project-blog", organizationId: "org-a", serviceName: "web",
    }, (entry) => entries.push(entry));
    await stream.done;
    expect(entries).toEqual([expect.objectContaining({ message: "Authorization [REDACTED] connected", level: "info" })]);
    expect(test.streamServiceLogs).toHaveBeenCalledWith(expect.objectContaining({ serviceId: "svc-web" }), expect.any(Function));
  });

  it("removes only the confirmed owned stack and waits for manager absence", async () => {
    const test = fixture();
    await expect(test.service.remove({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", expectedSourceVersion: 1,
    })).resolves.toMatchObject({ stackName: "blog", affectedServices: ["web"], state: "removed" });
    expect(test.removeStack).toHaveBeenCalledWith({ stackName: "blog" });
  });

  it("requires the exact stack name before a destructive stack operation", async () => {
    const test = fixture();
    await expect(test.service.remove({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "BLOG", expectedSourceVersion: 1,
    })).rejects.toMatchObject({ code: "SWARM_REMOVE_CONFIRMATION_INVALID", statusCode: 400 });
    expect(test.removeStack).not.toHaveBeenCalled();
  });

  it("refuses stack removal when Docker would delete stack-owned configs or secrets", async () => {
    const test = fixture({ stackOwnedPersistentObject: true });
    await expect(test.service.remove({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", expectedSourceVersion: 1,
    })).rejects.toMatchObject({ code: "SWARM_PERSISTENT_OBJECT_PRECONDITION", statusCode: 409 });
    expect(test.removeStack).not.toHaveBeenCalled();
  });

  it("reconciles an accepted removal after the manager response is lost without reissuing it", async () => {
    const test = fixture({ responseLostAfterRemove: true });
    await expect(test.service.remove({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", expectedSourceVersion: 1,
    })).resolves.toMatchObject({ state: "removed", output: expect.stringContaining("connection was lost") });
    expect(test.removeStack).toHaveBeenCalledTimes(1);
    expect(test.updateStack).toHaveBeenCalledWith("swarm-blog", "org-a", expect.objectContaining({
      driftDetails: expect.objectContaining({ operation: { kind: "remove", state: "removed" } }),
    }));
  });

  it("rejects a stale source version before issuing destructive removal", async () => {
    const test = fixture({ stackOverride: { ...stack, sourceVersion: 2 } });
    await expect(test.service.remove({
      projectId: "project-blog", organizationId: "org-a", confirmedStackName: "blog", expectedSourceVersion: 1,
    })).rejects.toMatchObject({ code: "SWARM_REMOVE_CONFIRMATION_STALE", statusCode: 409 });
    expect(test.removeStack).not.toHaveBeenCalled();
  });
});
