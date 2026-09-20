import { describe, expect, it, vi } from "vitest";
import { deleteCloudWorkspace } from "./workspace-delete";
import { CloudRuntime } from "../cloud";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

describe("Cloud workspace deletion", () => {
  it("waits for an accepted deletion to become absent without resubmitting it", async () => {
    const workspace = {
      delete: vi.fn(async () => ({ success: true, accepted: true })),
      get: vi.fn().mockResolvedValueOnce({ id: "ws-a", info: { status: "deleting" } })
        .mockRejectedValueOnce({ status: 404 }),
    };
    await deleteCloudWorkspace(workspace);
    expect(workspace.delete).toHaveBeenCalledOnce();
    expect(workspace.get).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy synchronous deletion compatible", async () => {
    const workspace = { delete: vi.fn(async () => ({ success: true })), get: vi.fn() };
    await deleteCloudWorkspace(workspace);
    expect(workspace.get).not.toHaveBeenCalled();
  });

  it("treats an already absent workspace as successful cleanup", async () => {
    const workspace = { delete: vi.fn().mockRejectedValue({ status: 404 }), get: vi.fn() };
    await deleteCloudWorkspace(workspace);
    expect(workspace.get).not.toHaveBeenCalled();
  });

  it("preserves a deletion refusal", async () => {
    const error = { status: 403, code: "namespace_scope_mismatch" };
    const workspace = { delete: vi.fn().mockRejectedValue(error), get: vi.fn() };
    await expect(deleteCloudWorkspace(workspace)).rejects.toBe(error);
    expect(workspace.get).not.toHaveBeenCalled();
  });

  it.each([403, 503])("does not mistake HTTP %i while confirming deletion for absence", async status => {
    const error = { status };
    const workspace = { delete: vi.fn(async () => ({ success: true, accepted: true })), get: vi.fn().mockRejectedValue(error) };
    await expect(deleteCloudWorkspace(workspace)).rejects.toBe(error);
  });

  it("keeps cleanup incomplete when an accepted deletion does not finish", async () => {
    const workspace = { delete: vi.fn(async () => ({ success: true, accepted: true })), get: vi.fn().mockResolvedValue({ id: "ws-a" }) };
    await expect(deleteCloudWorkspace(workspace, { timeoutMs: 0 })).rejects.toThrow("still deleting");
  });

  it("keeps project teardown retryable if deletion cannot be confirmed, without a billing gate", async () => {
    const error = { status: 503 };
    const workspace = { delete: vi.fn(async () => ({ success: true, accepted: true })), get: vi.fn().mockRejectedValue(error) };
    const beforeProvision = vi.fn(async () => { throw new Error("credit exhausted"); });
    const runtime = new CloudRuntime({ workspace: () => workspace } as never, { namespace: "tenant-a", beforeProvision });
    await expect(runtime.destroy("ws-a")).rejects.toBe(error);
    expect(beforeProvision).not.toHaveBeenCalled();
    workspace.get.mockRejectedValue({ status: 404 });
    await expect(runtime.destroy("ws-a")).resolves.toBeUndefined();
  });
});
