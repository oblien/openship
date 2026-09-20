import { describe, expect, it, vi } from "vitest";
import type { ProjectResources } from "@repo/core";
import {
  applyTopologyChanges,
  canRefreshChanges,
  canRefreshServicePatch,
  canStartAddedServices,
  changesAffectEnvironment,
  serviceChangeConflicts,
  serviceFromInput,
  stageServiceChange,
  type TopologyChange,
  type TopologyChangePorts,
} from "./changes";

const api = serviceFromInput("api", {
  name: "api",
  image: "acme/api:1",
  advanced: { resources: { cpuCores: 1, memoryMb: 512 } },
});
const worker = serviceFromInput("worker", { name: "worker", image: "acme/worker:1" });
const resources: ProjectResources = {
  production: { cpuCores: 1, memoryMb: 512, diskMb: 0 },
  build: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
  port: 3000,
  sleepMode: "off",
  tier: "custom",
  requiresLimit: false,
};
function ports(): TopologyChangePorts {
  return {
    listServices: vi.fn(async () => [api, worker]),
    createService: vi.fn(async (input) => serviceFromInput("new", input)),
    startService: vi.fn(async () => {}),
    updateService: vi.fn(async () => {}),
    readResources: vi.fn(async () => resources),
    updateResources: vi.fn(async () => {}),
    removeBinding: vi.fn(async () => {}),
    deploy: vi.fn(async () => ({ data: { deployment: { id: "d2" } } })),
  };
}
const resize = (): TopologyChange => ({
  id: "resources",
  kind: "resources",
  title: "Resize",
  before: resources.production,
  values: { cpuCores: 2, memoryMb: 1024 },
});
const create = (): TopologyChange => ({
  id: "new",
  kind: "create-service",
  title: "Add db",
  input: { name: "db", image: "postgres:16" },
});

describe("topology review and apply", () => {
  it("rejects a cycle introduced through configuration before any API writes", async () => {
    const io = ports();
    io.listServices = vi.fn(async () => [api, { ...worker, dependsOn: ["api"] }]);
    const changes = stageServiceChange([], api, { dependsOn: ["worker"] }, true);
    await expect(
      applyTopologyChanges({
        changes,
        intent: "refresh",
        deployed: true,
        ports: io,
        onSaved: () => {},
      }),
    ).rejects.toThrow("circular startup dependency");
    expect(io.updateService).not.toHaveBeenCalled();
    expect(io.deploy).not.toHaveBeenCalled();
  });
  it("keeps configuration and connections for a new node in one create operation", async () => {
    const io = ports();
    const pending = serviceFromInput("new", { name: "db", image: "postgres:16" });
    let changes = stageServiceChange([create()], pending, { dependsOn: ["api"] }, true);
    changes = stageServiceChange(
      changes,
      pending,
      { advanced: { resources: { cpuCores: 2, memoryMb: 1024 } } },
      true,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "create-service",
      input: { dependsOn: ["api"], advanced: { resources: { cpuCores: 2, memoryMb: 1024 } } },
    });
    await applyTopologyChanges({
      changes,
      intent: "update",
      deployed: true,
      ports: io,
      onSaved: () => {},
    });
    expect(io.createService).toHaveBeenCalledTimes(1);
    expect(io.updateService).not.toHaveBeenCalled();
    expect(io.startService).toHaveBeenCalledWith("new");
  });
  it("creates a new dependency before updating only the service wired to it", async () => {
    const io = ports();
    const changes = [...stageServiceChange([], api, { dependsOn: ["db"] }, true), create()];
    await applyTopologyChanges({
      changes,
      intent: "update",
      deployed: true,
      ports: io,
      onSaved: () => {},
    });
    expect(io.updateService).toHaveBeenCalledExactlyOnceWith("api", { dependsOn: ["db"] });
    expect(vi.mocked(io.createService).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(io.updateService).mock.invocationCallOrder[0],
    );
    expect(io.deploy).toHaveBeenCalledWith({ forceAll: true, serviceIds: ["new", "api"] });
  });
  it("can reapply runtime-only edits while requiring a build for changed source settings", () => {
    expect(
      canRefreshServicePatch(api, {
        image: api.image ?? undefined,
        command: "node worker.js",
        dependsOn: ["db"],
      }),
    ).toBe(true);
    expect(canRefreshServicePatch(api, { image: "acme/api:2" })).toBe(false);
    expect(canRefreshServicePatch(api, { build: "./api" })).toBe(false);
  });
  it("applies a service edit and redeploys only that service from its retained release", async () => {
    const io = ports();
    const changes = stageServiceChange(
      [],
      api,
      { advanced: { resources: { cpuCores: 2, memoryMb: 1024 } } },
      true,
    );
    const saved = vi.fn();
    await applyTopologyChanges({
      changes,
      intent: "refresh",
      deployed: true,
      ports: io,
      onSaved: saved,
    });
    expect(io.updateService).toHaveBeenCalledWith("api", {
      advanced: { resources: { cpuCores: 2, memoryMb: 1024 } },
    });
    expect(io.deploy).toHaveBeenCalledWith({ refresh: true, serviceIds: ["api"] });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ saved: true }));
  });
  it("makes an environment resource refresh explicitly include all services", async () => {
    const io = ports();
    await applyTopologyChanges({
      changes: [resize()],
      intent: "refresh",
      deployed: true,
      ports: io,
      onSaved: () => {},
    });
    expect(io.deploy).toHaveBeenCalledWith({ refresh: true, forceAll: true });
  });
  it("keeps a shared binding change at environment scope", async () => {
    const io = ports();
    await applyTopologyChanges({
      changes: [
        { id: "link", kind: "remove-binding", title: "Disconnect", connectionId: "binding1" },
      ],
      intent: "refresh",
      deployed: true,
      ports: io,
      onSaved: () => {},
    });
    expect(io.removeBinding).toHaveBeenCalledWith("binding1");
    expect(io.deploy).toHaveBeenCalledWith({ refresh: true, forceAll: true });
  });
  it("uses environment reconciliation to remove a disabled service container", async () => {
    const io = ports();
    const changes = stageServiceChange([], worker, { enabled: false }, true);
    expect(changesAffectEnvironment(changes)).toBe(true);
    await applyTopologyChanges({
      changes,
      intent: "refresh",
      deployed: true,
      ports: io,
      onSaved: () => {},
    });
    expect(io.updateService).toHaveBeenCalledWith("worker", { enabled: false });
    expect(io.deploy).toHaveBeenCalledWith({ refresh: true, forceAll: true });
  });
  it("rejects disabling the last deployable service before writing configuration", async () => {
    const io = ports();
    io.listServices = vi.fn(async () => [api]);
    const changes = stageServiceChange([], api, { enabled: false }, true);
    await expect(
      applyTopologyChanges({
        changes,
        intent: "refresh",
        deployed: true,
        ports: io,
        onSaved: () => {},
      }),
    ).rejects.toThrow("at least one service enabled");
    expect(io.updateService).not.toHaveBeenCalled();
    expect(io.deploy).not.toHaveBeenCalled();
  });
  it("requires a new deployment for newly created services or changed source", async () => {
    const io = ports();
    expect(canRefreshChanges([create()])).toBe(false);
    expect(canRefreshChanges(stageServiceChange([], api, { image: "acme/api:2" }, false))).toBe(
      false,
    );
    await expect(
      applyTopologyChanges({
        changes: [create()],
        intent: "refresh",
        deployed: true,
        ports: io,
        onSaved: () => {},
      }),
    ).rejects.toThrow("new deployment");
    expect(io.createService).not.toHaveBeenCalled();
  });
  it("stops before any writes when a reviewed field changed on the server", async () => {
    const io = ports();
    const changes = stageServiceChange([], api, { image: "acme/api:2" }, false);
    io.listServices = vi.fn(async () => [{ ...api, image: "acme/api:3" }, worker]);
    await expect(
      applyTopologyChanges({
        changes,
        intent: "update",
        deployed: true,
        ports: io,
        onSaved: () => {},
      }),
    ).rejects.toThrow("changed since");
    expect(io.updateService).not.toHaveBeenCalled();
    expect(io.deploy).not.toHaveBeenCalled();
  });
  it("allows unrelated changes and preserves the original baseline across repeated edits", () => {
    const first = stageServiceChange([], api, { image: "acme/api:2" }, false);
    const second = stageServiceChange(
      first,
      { ...api, image: "acme/api:2" },
      { command: "node main.js" },
      true,
    );
    const change = second[0];
    expect(change.kind).toBe("update-service");
    if (change.kind !== "update-service") throw new Error("wrong change");
    expect(change.before.image).toBe("acme/api:1");
    expect(change.patch).toMatchObject({ image: "acme/api:2", command: "node main.js" });
    expect(change.refresh).toBe(false);
    expect(serviceChangeConflicts(change, { ...api, volumes: ["new:/data"] })).toBe(false);
  });
  it("records each saved operation and retries a partial save without creating a duplicate", async () => {
    const io = ports();
    let changes = [create(), resize()];
    const saved = (receipt: TopologyChange) => {
      changes = changes.map((change) => (change.id === receipt.id ? receipt : change));
    };
    io.updateResources = vi
      .fn()
      .mockRejectedValueOnce(new Error("Server offline"))
      .mockResolvedValue(undefined);
    await expect(
      applyTopologyChanges({
        changes,
        intent: "update",
        deployed: true,
        ports: io,
        onSaved: saved,
      }),
    ).rejects.toThrow("Server offline");
    expect(changes[0]).toMatchObject({ saved: true, createdServiceId: "new" });
    expect(io.deploy).not.toHaveBeenCalled();
    await applyTopologyChanges({
      changes,
      intent: "update",
      deployed: true,
      ports: io,
      onSaved: saved,
    });
    expect(io.createService).toHaveBeenCalledTimes(1);
    expect(io.deploy).toHaveBeenCalledTimes(1);
  });
  it("retries a failed deployment without re-saving already accepted configuration", async () => {
    const io = ports();
    let changes: TopologyChange[] = [
      {
        id: "new",
        kind: "create-service",
        title: "Add frontend",
        input: { name: "frontend", kind: "monorepo", build: "./frontend" },
      },
    ];
    const saved = (receipt: TopologyChange) => {
      changes = [receipt];
    };
    io.deploy = vi
      .fn()
      .mockRejectedValueOnce(new Error("Deployment refused"))
      .mockResolvedValue({});
    await expect(
      applyTopologyChanges({
        changes,
        intent: "update",
        deployed: true,
        ports: io,
        onSaved: saved,
      }),
    ).rejects.toThrow("Deployment refused");
    await applyTopologyChanges({
      changes,
      intent: "update",
      deployed: true,
      ports: io,
      onSaved: saved,
    });
    expect(io.createService).toHaveBeenCalledTimes(1);
    expect(io.deploy).toHaveBeenLastCalledWith({ forceAll: true, serviceIds: ["new"] });
    expect(io.startService).not.toHaveBeenCalled();
  });
  it("launches an added image service through the existing start API without redeploying its parent", async () => {
    const io = ports();
    const saved = vi.fn();
    const result = await applyTopologyChanges({
      changes: [create()],
      intent: "update",
      deployed: true,
      ports: io,
      onSaved: saved,
    });
    expect(result).toEqual({ startedServices: ["new"] });
    expect(io.startService).toHaveBeenCalledWith("new");
    expect(io.deploy).not.toHaveBeenCalled();
    expect(saved).toHaveBeenLastCalledWith(
      expect.objectContaining({ saved: true, createdServiceId: "new", started: true }),
    );
  });
  it("launches dependencies first and retries only the services that did not start", async () => {
    const io = ports();
    io.createService = vi.fn(async (input) => serviceFromInput(`new-${input.name}`, input));
    io.startService = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Image pull failed"))
      .mockResolvedValue(undefined);
    let changes: TopologyChange[] = [
      {
        id: "frontend",
        kind: "create-service",
        title: "Add frontend",
        input: { name: "frontend", image: "acme/frontend:1", dependsOn: ["db"] },
      },
      create(),
    ];
    const saved = (receipt: TopologyChange) => {
      changes = changes.map((change) => (change.id === receipt.id ? receipt : change));
    };
    await expect(
      applyTopologyChanges({
        changes,
        intent: "update",
        deployed: true,
        ports: io,
        onSaved: saved,
      }),
    ).rejects.toThrow("Image pull failed");
    expect(io.startService).toHaveBeenNthCalledWith(1, "new-db");
    expect(io.startService).toHaveBeenNthCalledWith(2, "new-frontend");
    expect(changes[1]).toMatchObject({ started: true });
    const result = await applyTopologyChanges({
      changes,
      intent: "update",
      deployed: true,
      ports: io,
      onSaved: saved,
    });
    expect(result).toEqual({ startedServices: ["new-db", "new-frontend"] });
    expect(io.startService).toHaveBeenNthCalledWith(3, "new-frontend");
    expect(io.createService).toHaveBeenCalledTimes(2);
    expect(io.deploy).not.toHaveBeenCalled();
  });
  it("rejects a circular startup order before creating any service", async () => {
    const io = ports();
    const changes: TopologyChange[] = [
      {
        id: "one",
        kind: "create-service",
        title: "Add one",
        input: { name: "one", image: "acme/one:1", dependsOn: ["two"] },
      },
      {
        id: "two",
        kind: "create-service",
        title: "Add two",
        input: { name: "two", image: "acme/two:1", dependsOn: ["one"] },
      },
    ];
    await expect(
      applyTopologyChanges({
        changes,
        intent: "update",
        deployed: true,
        ports: io,
        onSaved: () => {},
      }),
    ).rejects.toThrow("circular startup dependency");
    expect(io.createService).not.toHaveBeenCalled();
  });
  it("does not use direct launch for a source build or a mixed configuration review", () => {
    expect(canStartAddedServices([create()])).toBe(true);
    expect(canStartAddedServices([create(), resize()])).toBe(false);
    expect(
      canStartAddedServices([
        {
          id: "source",
          kind: "create-service",
          title: "Source",
          input: { name: "source", image: "acme/source:1", build: "." },
        },
      ]),
    ).toBe(false);
    expect(canStartAddedServices([])).toBe(false);
  });
  it("does not widen a targeted deployment after the selected service was removed or disabled", async () => {
    const io = ports();
    io.listServices = vi.fn(async () => [{ ...api, enabled: false }]);
    for (const serviceId of ["api", "missing"]) {
      await expect(
        applyTopologyChanges({
          changes: [],
          intent: "refresh",
          deployed: true,
          serviceIds: [serviceId],
          ports: io,
          onSaved: () => {},
        }),
      ).rejects.toThrow("removed or disabled");
    }
    expect(io.deploy).not.toHaveBeenCalled();
  });
  it("saves an undeployed environment then hands off to the existing setup", async () => {
    const io = ports();
    const result = await applyTopologyChanges({
      changes: [create()],
      intent: "update",
      deployed: false,
      ports: io,
      onSaved: () => {},
    });
    expect(result).toEqual({ needsSetup: true });
    expect(io.createService).toHaveBeenCalledTimes(1);
    expect(io.deploy).not.toHaveBeenCalled();
    expect(io.startService).not.toHaveBeenCalled();
  });
  it("does not create a pending service whose name appeared during review", async () => {
    const io = ports();
    io.listServices = vi.fn(async () => [
      serviceFromInput("exists", { name: "db", image: "postgres:16" }),
    ]);
    await expect(
      applyTopologyChanges({
        changes: [create()],
        intent: "update",
        deployed: true,
        ports: io,
        onSaved: () => {},
      }),
    ).rejects.toThrow("already exists");
    expect(io.createService).not.toHaveBeenCalled();
  });
});
