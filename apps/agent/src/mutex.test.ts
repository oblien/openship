import { describe, expect, it } from "vitest";
import { BuildMutex } from "./mutex";

describe("build mutex", () => {
  it("runs one execute_release / builder at a time", async () => {
    const mutex = new BuildMutex();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.run(async () => {
      order.push("first-enter");
      await firstGate;
      order.push("first-leave");
      return 1;
    });
    const second = mutex.run(async () => {
      order.push("second-enter");
      return 2;
    });

    await Promise.resolve();
    expect(mutex.locked).toBe(true);
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-enter", "first-leave", "second-enter"]);
    expect(mutex.locked).toBe(false);
  });
});
