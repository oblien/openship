import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

function runtimeWithDocker(docker: Record<string, unknown>): DockerRuntime {
  return Object.assign(Object.create(DockerRuntime.prototype) as DockerRuntime, {
    connectionOptions: {},
    transport: { kind: "socket", description: "test", unreachableHint: "unavailable" },
    systemManager: null,
    _docker: docker,
  });
}

function network(id: string, initial: string[]) {
  const members = new Set(initial);
  return {
    members,
    inspect: vi.fn(async () => ({ Id: id, Containers: Object.fromEntries([...members].map(member => [member, {}])) })),
    connect: vi.fn(async ({ Container }: { Container: string }) => { members.add(Container); }),
    disconnect: vi.fn(async ({ Container }: { Container: string }) => { members.delete(Container); }),
    remove: vi.fn(async () => {}),
  };
}

describe("shared service Docker networking", () => {
  it("disconnects one consumer without removing the source or another consumer", async () => {
    const shared = network("openship-shared-db", ["source", "shop", "workers"]);
    const runtime = runtimeWithDocker({ getNetwork: () => shared });
    await runtime.leaveServiceGroupContainers("shared-db", ["shop", "shop", "already-gone"]);
    expect([...shared.members]).toEqual(["source", "workers"]);
    expect(shared.disconnect).toHaveBeenCalledExactlyOnceWith({ Container: "shop", Force: true });
    expect(shared.remove).not.toHaveBeenCalled();
  });

  it("removes an empty network after the final source and consumer leave", async () => {
    const shared = network("openship-shared-db", ["source", "shop"]);
    const runtime = runtimeWithDocker({ getNetwork: () => shared });
    await runtime.leaveServiceGroupContainers("shared-db", ["shop", "source"]);
    expect(shared.members.size).toBe(0);
    expect(shared.remove).toHaveBeenCalledOnce();
  });

  it("attaches adopted containers, revokes an old link and retains the project's own export", async () => {
    const old = network("openship-shared-old", ["old-source", "web"]);
    const incoming = network("openship-shared-new", ["new-source"]);
    const own = network("openship-shared-own", ["web", "other-consumer"]);
    const networks: Record<string, ReturnType<typeof network>> = {
      "openship-shared-old": old, "openship-shared-new": incoming, "openship-shared-own": own,
    };
    const runtime = runtimeWithDocker({
      getNetwork: (name: string) => networks[name],
      listContainers: async () => [{ Id: "web", HostConfig: { NetworkMode: "bridge" }, NetworkSettings: { Networks: {
        "openship-shared-old": { NetworkID: "openship-shared-old" },
        "openship-shared-own": { NetworkID: "openship-shared-own" },
      } } }],
      getContainer: () => ({ inspect: async () => ({ Id: "adopted", HostConfig: { NetworkMode: "bridge" }, NetworkSettings: { Networks: {} } }) }),
    });
    await runtime.attachToExternalNetworks("consumer", ["openship-shared-new"], ["adopted"], {
      prunePrefix: "openship-shared-", retain: ["openship-shared-own"], strict: true,
    });
    expect([...incoming.members]).toEqual(["new-source", "web", "adopted"]);
    expect([...old.members]).toEqual(["old-source"]);
    expect([...own.members]).toEqual(["web", "other-consumer"]);
    expect(own.disconnect).not.toHaveBeenCalled();
  });

  it("attaches only the release candidate without reconciling the live app's networks", async () => {
    const old = network("openship-shared-old", ["live-app"]);
    const database = network("openship-shared-db", ["database"]);
    const listContainers = vi.fn();
    const getContainer = vi.fn((id: string) => ({ inspect: async () => ({
      Id: id, HostConfig: { NetworkMode: "bridge" }, NetworkSettings: { Networks: {} },
    }) }));
    const runtime = runtimeWithDocker({
      listContainers, getContainer,
      getNetwork: (name: string) => name === "openship-shared-db" ? database : old,
    });
    await runtime.attachToExternalNetworks("app", ["openship-shared-db"], ["live-app"], {
      onlyContainerIds: ["release"], prunePrefix: "openship-shared-", strict: true,
    });
    expect(listContainers).not.toHaveBeenCalled();
    expect(getContainer).toHaveBeenCalledExactlyOnceWith("release");
    expect([...database.members]).toEqual(["database", "release"]);
    expect([...old.members]).toEqual(["live-app"]);
    expect(old.disconnect).not.toHaveBeenCalled();
  });

  it("reports an unreachable daemon when a private connection is required", async () => {
    const runtime = runtimeWithDocker({ listContainers: async () => { throw new Error("daemon unreachable"); } });
    await expect(runtime.attachToExternalNetworks("consumer", ["openship-shared-db"], [], { strict: true })).rejects.toThrow("daemon unreachable");
    await expect(runtime.attachToExternalNetworks("legacy", ["openship-project"])).resolves.toBeUndefined();
  });

  it("rejects containers that cannot join a private bridge network", async () => {
    const shared = network("openship-shared-db", ["source"]);
    const runtime = runtimeWithDocker({
      getNetwork: () => shared,
      listContainers: async () => [{ Id: "web", HostConfig: { NetworkMode: "host" }, NetworkSettings: { Networks: {} } }],
    });
    await expect(runtime.attachToExternalNetworks("consumer", ["openship-shared-db"], [], { strict: true })).rejects.toThrow(/bridge networking/);
    expect(shared.connect).not.toHaveBeenCalled();
  });

  it("joins only the selected source container and propagates failed exports", async () => {
    const shared = network("openship-shared-db", []);
    const runtime = runtimeWithDocker({ getNetwork: () => shared });
    vi.spyOn(runtime, "ensureNetwork").mockResolvedValue("openship-shared-db");
    await runtime.joinServiceGroupContainers("shared-db", [{ containerId: "db", aliases: ["shared-db"] }], { strict: true });
    expect(shared.connect).toHaveBeenCalledWith({ Container: "db", EndpointConfig: { Aliases: ["shared-db"] } });
    shared.connect.mockRejectedValueOnce(new Error("endpoint unavailable"));
    await expect(runtime.joinServiceGroupContainers("shared-db", [{ containerId: "new-db", aliases: ["shared-db"] }], { strict: true })).rejects.toThrow("endpoint unavailable");
  });
});
