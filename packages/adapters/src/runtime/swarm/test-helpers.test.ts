import { describe, expect, it, vi } from "vitest";
import {
  readFixtureTasks,
  SWARM_FIXTURE_STACK,
  waitForFixtureConvergence,
} from "./test-helpers";

describe("Swarm lab test helpers", () => {
  it("reads only the fixed fixture stack and normalizes task rows", async () => {
    const exec = vi.fn().mockResolvedValue(
      [
        JSON.stringify({
          ID: "task-1",
          Name: "openship-swarm-fixture_web.1",
          CurrentState: "Running 5 seconds ago",
          DesiredState: "Running",
        }),
      ].join("\n"),
    );

    await expect(readFixtureTasks({ exec })).resolves.toEqual([
      {
        id: "task-1",
        name: "openship-swarm-fixture_web.1",
        currentState: "Running 5 seconds ago",
        desiredState: "Running",
      },
    ]);
    expect(exec).toHaveBeenCalledWith(
      `docker stack ps '${SWARM_FIXTURE_STACK}' --no-trunc --format '{{json .}}'`,
    );
    await expect(readFixtureTasks({ exec }, "operator-stack")).rejects.toThrow(
      "Refusing to inspect non-fixture",
    );
  });

  it("waits for a caller-defined converged task snapshot", async () => {
    const read = vi
      .fn<() => Promise<Array<{ id: string; name: string; currentState: string; desiredState: string }>>>()
      .mockResolvedValueOnce([
        { id: "1", name: "web.1", currentState: "Preparing", desiredState: "Running" },
      ])
      .mockResolvedValueOnce([
        { id: "1", name: "web.1", currentState: "Running", desiredState: "Running" },
      ]);

    await expect(
      waitForFixtureConvergence(read, (tasks) => tasks.every((task) => task.currentState === "Running"), {
        intervalMs: 0,
      }),
    ).resolves.toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
