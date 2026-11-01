import { describe, expect, it, vi } from "vitest";
import { CloudDockerRuntime } from "./docker";
import type { ProvisionLock } from "../../types";

const projectId = "project-a";
const networkName = "openship-retained-slug";
const networkId = "a".repeat(64);

function fixture(owner: unknown = projectId, id: unknown = networkId) {
  let locked = false;
  const inspect = vi.fn(async () => {
    expect(locked).toBe(true);
    return { Id: id, Labels: { "openship.project": owner } };
  });
  const remove = vi.fn(async () => {
    expect(locked).toBe(true);
  });
  const removeByName = vi.fn();
  const getNetwork = vi.fn((ref: string) => {
    if (ref === networkName) return { inspect, remove: removeByName };
    if (ref === networkId) return { remove };
    throw new Error(`Unexpected network reference: ${ref}`);
  });
  const provisionLock: ProvisionLock = {
    async run(work) {
      expect(locked).toBe(false);
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
  };
  const runtime = Object.create(CloudDockerRuntime.prototype) as CloudDockerRuntime;
  Object.assign(runtime, { projectId, options: { provisionLock }, _docker: { getNetwork } });
  return { runtime, inspect, remove, removeByName, getNetwork };
}

describe("Cloud project network cleanup", () => {
  it("preserves a stale slug's foreign network during project cleanup", async () => {
    const f = fixture("project-b");
    await expect(f.runtime.removeProjectNetwork("retained-slug")).resolves.toBeUndefined();
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.removeByName).not.toHaveBeenCalled();
  });

  it("keeps ordinary removal strict for a foreign owner", async () => {
    const f = fixture("project-b");
    await expect(f.runtime.removeNetwork("retained-slug")).rejects.toMatchObject({
      code: "CLOUD_NETWORK_CONFLICT",
    });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.removeByName).not.toHaveBeenCalled();
  });

  it.each([null, "", "   ", " project-b ", 42, {}, []])(
    "blocks cleanup when the ownership label is not authoritative: %j",
    async (owner) => {
      const f = fixture(owner);
      await expect(f.runtime.removeProjectNetwork("retained-slug")).rejects.toMatchObject({
        code: "CLOUD_NETWORK_CONFLICT",
      });
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.removeByName).not.toHaveBeenCalled();
    },
  );

  it("blocks cleanup when the ownership label is absent", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce({ Id: networkId, Labels: {} } as never);
    await expect(f.runtime.removeProjectNetwork("retained-slug")).rejects.toMatchObject({
      code: "CLOUD_NETWORK_CONFLICT",
    });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("propagates unavailable ownership observations", async () => {
    const f = fixture();
    f.inspect.mockRejectedValueOnce(new Error("Docker connection lost"));
    await expect(f.runtime.removeProjectNetwork("retained-slug")).rejects.toThrow(
      "Docker connection lost",
    );
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each(["removeProjectNetwork", "removeNetwork"] as const)(
    "%s removes the freshly inspected identity under the provision lock",
    async (method) => {
      const f = fixture();
      await expect(f.runtime[method]("retained-slug")).resolves.toBeUndefined();
      expect(f.getNetwork.mock.calls).toEqual([[networkName], [networkId]]);
      expect(f.remove).toHaveBeenCalledOnce();
      expect(f.removeByName).not.toHaveBeenCalled();
    },
  );

  it("cannot delete a foreign replacement that reuses the inspected network's name", async () => {
    const f = fixture();
    const replacementRemove = vi.fn();
    f.inspect.mockImplementationOnce(async () => {
      // The original disappears and a foreign network immediately takes its name.
      f.getNetwork.mockImplementation((ref: string) => {
        if (ref === networkName) return { inspect: f.inspect, remove: replacementRemove };
        if (ref === networkId) return { remove: f.remove };
        throw new Error("Unexpected network reference");
      });
      f.remove.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 404 }));
      return { Id: networkId, Labels: { "openship.project": projectId } };
    });
    await expect(f.runtime.removeProjectNetwork("retained-slug")).resolves.toBeUndefined();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(replacementRemove).not.toHaveBeenCalled();
    expect(f.getNetwork.mock.calls).toEqual([[networkName], [networkId]]);
  });

  it.each([null, "", "openship-another-network"])(
    "refuses an invalid immutable identity: %j",
    async (id) => {
      const f = fixture(projectId, id);
      await expect(f.runtime.removeProjectNetwork("retained-slug")).rejects.toMatchObject({
        code: "CLOUD_NETWORK_CONFLICT",
      });
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.removeByName).not.toHaveBeenCalled();
    },
  );

  it.each(["inspect", "remove"] as const)(
    "treats an absent network at %s as success",
    async (phase) => {
      const f = fixture();
      f[phase].mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 404 }));
      await expect(f.runtime.removeProjectNetwork("retained-slug")).resolves.toBeUndefined();
      expect(f.removeByName).not.toHaveBeenCalled();
    },
  );

  it("propagates Docker's refusal instead of disconnecting or forcing an attached network", async () => {
    const f = fixture();
    f.remove.mockRejectedValueOnce(
      Object.assign(new Error("network has active endpoints"), { statusCode: 403 }),
    );
    await expect(f.runtime.removeProjectNetwork("retained-slug")).rejects.toThrow(
      "network has active endpoints",
    );
    expect(f.remove).toHaveBeenCalledExactlyOnceWith();
    expect(f.removeByName).not.toHaveBeenCalled();
  });
});
