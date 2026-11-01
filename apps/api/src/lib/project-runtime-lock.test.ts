import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findProject: vi.fn(),
  admission: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: h.findProject },
    deployment: { listPendingRoleHandovers: async () => [] },
  },
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
}));

vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({ withCloudWorkspaceActivity: h.admission }));
import { withLiveProjectRuntimeMutation, withProjectRuntimeLock, withProjectStateLock } from "@repo/platform/engine/lib/project-runtime-lock";

describe("project runtime lock", () => {
  beforeEach(() => {
    h.findProject.mockReset();
    h.admission.mockReset().mockImplementation((_id: string, work: () => Promise<unknown>) => work());
  });

  it("rechecks project liveness only after an earlier mutation releases the lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withProjectRuntimeLock("p1", () => gate);
    h.findProject.mockResolvedValue({ id: "p1", deletionInProgress: true });
    const mutate = vi.fn(async () => "written");
    const queued = withLiveProjectRuntimeMutation("p1", mutate);

    await Promise.resolve();
    expect(mutate).not.toHaveBeenCalled();
    release();

    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("is reentrant for nested domain/route helpers on the same project", async () => {
    h.findProject.mockResolvedValue({ id: "p1", deletionInProgress: false });

    const result = await withLiveProjectRuntimeMutation("p1", () =>
      withLiveProjectRuntimeMutation("p1", async () => "ok"),
    );

    expect(result).toBe("ok");
    expect(h.findProject).toHaveBeenCalledTimes(3);
  });

  it("admits DB-only submission while a sibling Cloud build owns host admission", async () => {
    h.findProject.mockResolvedValue({ id: "next", workspaceId: "shared" });
    h.admission.mockRejectedValue(new Error("Cloud build owns host"));
    await expect(withProjectStateLock("next", async () => "queued")).resolves.toBe("queued");
    await expect(withProjectRuntimeLock("next", async () => "changed runtime")).rejects.toThrow("Cloud build owns host");
  });

  it("serializes DB-only submission with runtime mutation on the same project", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const runtime = withProjectRuntimeLock("p1", async () => { await gate; order.push("runtime"); });
    await Promise.resolve();
    await Promise.resolve();
    const submission = withProjectStateLock("p1", async () => { order.push("submission"); });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([runtime, submission]);
    expect(order).toEqual(["runtime", "submission"]);
  });

  it("refuses to upgrade DB-only ownership into runtime privileges", async () => {
    const mutate = vi.fn();
    await expect(withProjectStateLock("p1", () => withProjectRuntimeLock("p1", mutate))).rejects.toMatchObject({
      code: "PROJECT_RUNTIME_LOCK_UPGRADE_FORBIDDEN",
    });
    expect(mutate).not.toHaveBeenCalled();
  });
});
