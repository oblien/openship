import { describe, it, expect, vi } from "vitest";
import { DockerRuntime } from "../src/runtime/docker";
import { BareRuntime } from "../src/runtime/bare";

/**
 * Which VERB a ref gets, guarded at the runtime rather than only at the callers
 * that classify.
 *
 * This is issue #640 from the adapter side. A static deploy stores a host
 * DIRECTORY in `service_deployment.image_ref`; teardown classified any imageRef on
 * a Docker runtime as an image and called `removeImage`, and dockerode duly issued
 * `DELETE /images//opt/openship/static/...`. That failure is not a 404, so
 * `removeImage` rethrew it, `runtime_cleanup` was marked failed, the atomicity gate
 * kept the project row, and the delete could never complete — on every retry.
 *
 * The classification fix lives in the API. These assertions make the mistake
 * IMPOSSIBLE to reintroduce silently from any other caller.
 */

// A socket transport resolves synchronously and dials nothing, so a runtime can
// be built in a unit test; every daemon-touching method below is spied.
const dockerSocket = { transport: "socket" } as const;

describe("DockerRuntime.removeImage", () => {
  it("rejects a host path before it ever reaches dockerode", async () => {
    const rt = await DockerRuntime.create(dockerSocket);
    const getImage = vi.spyOn(
      (rt as unknown as { docker: { getImage: (r: string) => unknown } }).docker,
      "getImage",
    );

    await expect(rt.removeImage("/opt/openship/static/.builds/bld_1-svc_1")).rejects.toThrow(
      /host directory, not an image reference/,
    );
    // The point of guarding here rather than at the call site: no request is even
    // formed, so there is no daemon-version-dependent status to interpret.
    expect(getImage).not.toHaveBeenCalled();
  });

  it("still accepts a real tag", async () => {
    const rt = await DockerRuntime.create(dockerSocket);
    const remove = vi.fn(async () => {});
    vi.spyOn(
      (rt as unknown as { docker: { getImage: (r: string) => unknown } }).docker,
      "getImage",
    ).mockReturnValue({ remove } as never);

    await rt.removeImage("openship/my-app:bld_1");
    expect(remove).toHaveBeenCalledWith({ force: true });
  });
});

describe("DockerRuntime.destroy on a path", () => {
  it("refuses a path outside the managed tree", async () => {
    const rt = await DockerRuntime.create(dockerSocket);
    await expect(rt.destroy("/etc")).rejects.toThrow(/outside \/opt\/openship/);
  });

  it("refuses to remove a remote path on the LOCAL filesystem", async () => {
    // An SSH transport with no executor used to fall through to node:fs, deleting
    // the path on the orchestrator — the wrong machine — and reporting success.
    const rt = await DockerRuntime.create(dockerSocket);
    const self = rt as unknown as {
      transport: { kind: string };
      connectionOptions?: { executor?: unknown };
    };
    self.transport = { kind: "ssh" };
    self.connectionOptions = {};

    await expect(rt.destroy("/opt/openship/static/releases/dep_1")).rejects.toThrow(
      /no command executor/,
    );
  });

  it("removes a managed path over the SSH executor when it has one", async () => {
    const rt = await DockerRuntime.create(dockerSocket);
    const executor = { exec: vi.fn(async () => ""), exists: vi.fn(async () => false) };
    const self = rt as unknown as {
      transport: { kind: string };
      connectionOptions?: { executor?: unknown };
    };
    self.transport = { kind: "ssh" };
    self.connectionOptions = { executor };

    await rt.destroy("/opt/openship/static/releases/dep_1");
    expect(executor.exec).toHaveBeenCalledWith(
      "rm -rf '/opt/openship/static/releases/dep_1'",
    );
  });
});

describe("BareRuntime.destroy on a path", () => {
  const makeExecutor = () => ({
    exec: vi.fn(async () => ""),
    exists: vi.fn(async () => false),
    rm: vi.fn(async () => {}),
  });

  it("removes a release dir through the verified remover, not the swallowing rm", async () => {
    // `executor.rm` swallows every error on BOTH implementations, so routing the
    // artifact destroy through it made the operation incapable of failing.
    const executor = makeExecutor();
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });

    await rt.destroy("/opt/openship/static/releases/dep_1");
    expect(executor.exec).toHaveBeenCalledWith("rm -rf '/opt/openship/static/releases/dep_1'");
    expect(executor.rm).not.toHaveBeenCalled();
  });

  it("refuses a path outside the managed tree", async () => {
    const executor = makeExecutor();
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });

    await expect(rt.destroy("/home/deploy/site")).rejects.toThrow(/outside \/opt\/openship/);
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("reports a removal that did not take", async () => {
    const executor = makeExecutor();
    executor.exists = vi.fn(async () => true);
    const rt = new BareRuntime({ workDir: "/opt/openship/static", executor: executor as never });

    await expect(rt.destroy("/opt/openship/static/releases/dep_1")).rejects.toThrow(
      /still present/,
    );
  });
});
