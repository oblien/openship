import { expect, it } from "vitest";
import { createTaskGroup } from "../src/state/task-group";

it("drains work spawned during teardown and keeps independent owners isolated", async () => {
  const first = createTaskGroup(), second = createTaskGroup();
  let finish!: () => void, finishChild!: () => void, finishOther!: () => void;
  const other = second.track(new Promise<void>(resolve => { finishOther = resolve; }));
  first.track(new Promise<void>(resolve => { finish = resolve; }).then(() => {
    first.track(new Promise<void>(resolve => { finishChild = resolve; }));
  }));
  let drained = false;
  const drain = first.drain().then(() => { drained = true; });
  finish();
  await Promise.resolve();
  expect(drained).toBe(false);
  finishChild();
  await drain;
  expect(drained).toBe(true);
  finishOther();
  await other;
  const failure = first.track(Promise.reject(new Error("failed cleanup")));
  await expect(failure).rejects.toThrow("failed cleanup");
  await first.drain();
});
