import { beforeEach, describe, expect, it, vi } from "vitest";

// deliver builds ON THE TARGET, never cross-building on the control plane, so the unit
// under test is the CONTROL FLOW keyed off what the target already has: the image-present
// short-circuit, checkout-readable → build-in-place, else ship-source → build → rm.
// Docker/SSH themselves are mocked (buildImage, imageExistsLocally); only the routing
// between the three shapes is exercised here.
vi.mock("@repo/adapters", () => ({
  buildImage: vi.fn(async () => {}),
  imageExistsLocally: vi.fn(async () => false),
}));
vi.mock("./edge-image", () => ({ edgeBuildSpec: vi.fn() }));
vi.mock("./mail-image", () => ({ mailBuildSpec: vi.fn() }));

import { buildImage, imageExistsLocally } from "@repo/adapters";

import { deliverManagedImage } from "./deliver-managed-image";
import { edgeBuildSpec } from "./edge-image";
import { mailBuildSpec } from "./mail-image";

const SPEC = { context: "/repo", dockerfile: "apps/edge/Dockerfile" };
const onLog = () => {};

/** A fake target executor recording exists/transferIn/rm, with configurable checkout presence. */
function target(opts: { checkoutHere?: boolean } = {}) {
  const calls = {
    exists: [] as string[],
    transferIn: [] as Array<[string, string]>,
    rm: [] as string[],
  };
  const executor = {
    exists: vi.fn(async (p: string) => {
      calls.exists.push(p);
      return opts.checkoutHere ?? false;
    }),
    transferIn: vi.fn(async (from: string, to: string) => {
      calls.transferIn.push([from, to]);
    }),
    rm: vi.fn(async (p: string) => {
      calls.rm.push(p);
    }),
  } as unknown as Parameters<typeof deliverManagedImage>[0]["targetExecutor"];
  return { executor, calls };
}

const mockBuildImage = buildImage as ReturnType<typeof vi.fn>;
const mockImageExists = imageExistsLocally as ReturnType<typeof vi.fn>;
const mockEdgeSpec = edgeBuildSpec as ReturnType<typeof vi.fn>;
const mockMailSpec = mailBuildSpec as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockImageExists.mockResolvedValue(false);
});

describe("deliverManagedImage", () => {
  it("short-circuits in prod (no buildSpec) without probing, building or shipping", async () => {
    mockEdgeSpec.mockReturnValue(undefined);
    const { executor, calls } = target();

    const res = await deliverManagedImage({
      kind: "edge",
      image: "ghcr.io/oblien/openship-edge:0.5.0",
      targetExecutor: executor,
      onLog,
    });

    expect(res).toEqual({ delivered: false });
    expect(mockImageExists).not.toHaveBeenCalled();
    expect(mockBuildImage).not.toHaveBeenCalled();
    expect(calls.exists).toHaveLength(0);
    expect(calls.transferIn).toHaveLength(0);
  });

  it("short-circuits when the content tag is already on the box (no build, no ship)", async () => {
    mockEdgeSpec.mockReturnValue(SPEC);
    mockImageExists.mockResolvedValue(true);
    const { executor, calls } = target({ checkoutHere: true });

    const res = await deliverManagedImage({
      kind: "edge",
      image: "ghcr.io/oblien/openship-edge:0.5.0-dev.abc123",
      targetExecutor: executor,
      onLog,
    });

    expect(res).toEqual({ delivered: true });
    expect(mockBuildImage).not.toHaveBeenCalled();
    // The image-present short-circuit fires BEFORE the checkout probe.
    expect(calls.exists).toHaveLength(0);
    expect(calls.transferIn).toHaveLength(0);
  });

  it("builds in place when the checkout is readable on the target (self / This Machine)", async () => {
    mockEdgeSpec.mockReturnValue(SPEC);
    const { executor, calls } = target({ checkoutHere: true });

    const res = await deliverManagedImage({
      kind: "edge",
      image: "img:dev.abc",
      targetExecutor: executor,
      onLog,
    });

    expect(res).toEqual({ delivered: true });
    expect(mockBuildImage).toHaveBeenCalledTimes(1);
    // Builds from the checkout's own path — no ship, no temp dir to clean up.
    expect(mockBuildImage.mock.calls[0][2]).toEqual(SPEC);
    expect(mockBuildImage.mock.calls[0][4]).toBe("edge");
    // Probed the Dockerfile at its context-joined path.
    expect(calls.exists[0]).toBe("/repo/apps/edge/Dockerfile");
    expect(calls.transferIn).toHaveLength(0);
    expect(calls.rm).toHaveLength(0);
  });

  it("remote box: ships the source to a temp dir, builds there, then removes it", async () => {
    mockMailSpec.mockReturnValue({ context: "/repo", dockerfile: "apps/email/Dockerfile" });
    const { executor, calls } = target({ checkoutHere: false });

    const res = await deliverManagedImage({
      kind: "mail",
      image: "ghcr.io/oblien/openship-mail:0.5.0-dev.def456",
      targetExecutor: executor,
      onLog,
    });

    expect(res).toEqual({ delivered: true });
    expect(calls.transferIn).toHaveLength(1);
    const [from, to] = calls.transferIn[0];
    expect(from).toBe("/repo");
    // Temp dir is kind + sanitized-tag scoped so edge and mail can't collide.
    expect(to).toContain("openship-managed-build-mail-");
    // Built from the SHIPPED context, not the control-plane path.
    expect(mockBuildImage).toHaveBeenCalledTimes(1);
    expect(mockBuildImage.mock.calls[0][2]).toEqual({
      context: to,
      dockerfile: "apps/email/Dockerfile",
    });
    // Cleaned up the temp context.
    expect(calls.rm).toEqual([to]);
  });

  it("remote box: still removes the temp dir when the build throws", async () => {
    mockMailSpec.mockReturnValue({ context: "/repo", dockerfile: "apps/email/Dockerfile" });
    mockBuildImage.mockRejectedValueOnce(new Error("build blew up"));
    const { executor, calls } = target({ checkoutHere: false });

    await expect(
      deliverManagedImage({ kind: "mail", image: "img:dev.def", targetExecutor: executor, onLog }),
    ).rejects.toThrow(/build blew up/);

    expect(calls.transferIn).toHaveLength(1);
    expect(calls.rm).toHaveLength(1); // finally block ran
  });
});
