import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findProject: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: { project: { findById: h.findProject } },
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
}));

import { withLiveProjectRuntimeMutation, withProjectRuntimeLock } from "./project-runtime-lock";

describe("project runtime lock", () => {
  beforeEach(() => {
    h.findProject.mockReset();
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
    expect(h.findProject).not.toHaveBeenCalled();
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
    expect(h.findProject).toHaveBeenCalledTimes(2);
  });
});
