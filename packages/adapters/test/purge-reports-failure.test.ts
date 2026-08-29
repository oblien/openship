import { describe, it, expect, vi } from "vitest";
import { DockerRuntime } from "../src/runtime/docker";
import { BareRuntime } from "../src/runtime/bare";

/**
 * `purge()` is the verb that ENDS a release: the caller
 * (`rollback/rollback-orchestrator.ts` → `prune`) reads a resolved purge as "the
 * artifact is gone" and clears `artifact_retained_at` on the row. Nothing ever
 * looks at that release again.
 *
 * So a `purge` that cannot fail is a `purge` that launders a leak into a clean
 * record: the release directory (or container, or image) stays on the box, the
 * row says it was reclaimed, and the disk never comes back. Both runtimes wrapped
 * both of their removals in a blanket `catch {}`, which bought nothing —
 * `destroy`, `removeImage` and `removeManagedArtifact` each already treat
 * already-absent as success, so replays were idempotent without it — and cost
 * exactly the signal `removeManagedArtifact` was written to provide.
 *
 * The other half of the contract is that a failure must not be contagious: both
 * removals are attempted regardless, so one unreachable supervisor or one stuck
 * container cannot strand the artifact next to it.
 */

const dockerSocket = { transport: "socket" } as const;

const RELEASE = "/opt/openship/static/releases/dep_1";

/** Executor whose `rm -rf` runs but whose target may survive it (EACCES, ro mount). */
function makeExecutor(opts: { survives?: boolean; execThrows?: boolean } = {}) {
  return {
    exec: vi.fn(async () => {
      if (opts.execThrows) throw new Error("Permission denied");
      return "";
    }),
    exists: vi.fn(async () => opts.survives === true),
    rm: vi.fn(async () => {}),
  };
}

describe("BareRuntime.purge", () => {
  it("resolves when the release directory is really gone", async () => {
    const executor = makeExecutor();
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });

    await rt.purge({ id: "dep_1", projectId: "p1", imageRef: null, containerId: RELEASE });

    // containerId IS the release dir for a static release, so exactly one removal.
    expect(executor.exec).toHaveBeenCalledTimes(1);
    expect(executor.exec).toHaveBeenCalledWith(`rm -rf '${RELEASE}'`);
  });

  it("rejects when the release directory survives the removal", async () => {
    const executor = makeExecutor({ survives: true });
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });

    await expect(
      rt.purge({ id: "dep_1", projectId: "p1", imageRef: null, containerId: RELEASE }),
    ).rejects.toThrow(/still present/);
  });

  it("goes through the verified remover for the derived release dir, not the swallowing rm", async () => {
    // No containerId: the release dir is derived from the id, and `executor.rm`
    // swallows every error on both executor implementations — which is what made
    // this branch incapable of reporting anything.
    const executor = makeExecutor({ survives: true });
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });

    await expect(
      rt.purge({ id: "dep_1", projectId: "p1", imageRef: null, containerId: null }),
    ).rejects.toThrow(/still present/);
    expect(executor.rm).not.toHaveBeenCalled();
  });

  it("still attempts the directory when the supervisor unit cannot be destroyed, and names both", async () => {
    const executor = makeExecutor({ survives: true });
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });
    // A unit-name containerId takes the supervisor branch; make it fail the way an
    // unreachable host channel does.
    (rt as unknown as { supervisor: () => Promise<unknown> }).supervisor = async () => {
      throw new Error("host channel is not provisioned");
    };

    const err = await rt
      .purge({ id: "dep_1", projectId: "p1", imageRef: null, containerId: "openship-dep_1" })
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(err?.message).toMatch(/host channel is not provisioned/);
    expect(err?.message).toMatch(/still present/);
    // The disk was not held hostage by the supervisor failure.
    expect(executor.exec).toHaveBeenCalledWith(
      `rm -rf '/opt/openship/static/releases/dep_1'`,
    );
  });
});

describe("DockerRuntime.purge", () => {
  /** Runtime with both removal verbs stubbed; either can be made to fail. */
  async function runtimeSpy(fail: { container?: boolean; image?: boolean } = {}) {
    const runtime = await DockerRuntime.create(dockerSocket);
    const calls = { destroyed: [] as string[], removed: [] as string[] };
    runtime.destroy = async (id: string) => {
      calls.destroyed.push(id);
      if (fail.container) throw new Error("conflict: container is in use");
    };
    runtime.removeImage = async (ref: string) => {
      calls.removed.push(ref);
      if (fail.image) throw new Error("image is referenced in multiple repositories");
    };
    return { runtime, calls };
  }

  const ref = {
    id: "dep_1",
    projectId: "p1",
    imageRef: "openship/app:bld_1",
    containerId: "c1",
  };

  it("resolves when both removals succeed", async () => {
    const { runtime, calls } = await runtimeSpy();
    await runtime.purge(ref);
    expect(calls).toEqual({ destroyed: ["c1"], removed: ["openship/app:bld_1"] });
  });

  it("rejects when the container could not be removed, and still attempts the image", async () => {
    const { runtime, calls } = await runtimeSpy({ container: true });

    await expect(runtime.purge(ref)).rejects.toThrow(/container is in use/);
    expect(calls.removed).toEqual(["openship/app:bld_1"]);
  });

  it("rejects when the image could not be removed", async () => {
    const { runtime } = await runtimeSpy({ image: true });
    await expect(runtime.purge(ref)).rejects.toThrow(/multiple repositories/);
  });

  it("still withholds an unowned tag rather than failing on it", async () => {
    // The ownership gate is upstream of the failure reporting: a migration-adopted
    // tag is never touched, so it can never be the reason a purge fails.
    const { runtime, calls } = await runtimeSpy();
    await runtime.purge({ ...ref, imageRef: "migration-360p-app:latest" });
    expect(calls.removed).toEqual([]);
  });
});
