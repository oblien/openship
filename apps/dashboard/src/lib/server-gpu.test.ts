import { describe, expect, it } from "vitest";
import { gpuMismatch, serverHasGpu, sortForGpu } from "./server-gpu";

const gpu = (over: Partial<NonNullable<Parameters<typeof serverHasGpu>[0]>["gpu"]> = {}) =>
  ({
    available: true,
    detected: true,
    count: 1,
    override: null,
    probed: true,
    ...over,
  }) as never;
const s = (id: string, g?: unknown) => ({ id, gpu: g }) as { id: string; gpu?: never };

describe("sortForGpu", () => {
  const list = [s("a"), s("b", gpu()), s("c", gpu({ available: false })), s("d", gpu())];
  it("lists GPU servers first and keeps order inside each group", () => {
    expect(sortForGpu(list, true).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("never removes a server and leaves the order alone when no GPU is needed", () => {
    expect(sortForGpu(list, true)).toHaveLength(4);
    expect(sortForGpu(list, false).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("serverHasGpu", () => {
  it("is false without an annotation (managed servers) and follows `available`", () => {
    expect(serverHasGpu(undefined)).toBe(false);
    expect(serverHasGpu({})).toBe(false);
    expect(serverHasGpu({ gpu: gpu() })).toBe(true);
    expect(serverHasGpu({ gpu: gpu({ available: false }) })).toBe(false);
  });
});

describe("gpuMismatch", () => {
  it("flags only the two real disagreements", () => {
    expect(gpuMismatch(gpu({ override: "yes", detected: false, available: true }))).toBe(
      "yes-not-detected",
    );
    expect(gpuMismatch(gpu({ override: "no", detected: true, available: false }))).toBe(
      "no-but-detected",
    );
    expect(gpuMismatch(gpu({ override: "yes", detected: true }))).toBeNull();
    expect(gpuMismatch(gpu({ override: null }))).toBeNull();
  });
  it("says nothing when the daemon was not read (an unprobed box is not a disagreement)", () => {
    expect(gpuMismatch(gpu({ override: "yes", detected: false, probed: false }))).toBeNull();
  });
});
