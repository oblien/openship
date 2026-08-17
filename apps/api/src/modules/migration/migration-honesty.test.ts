import { describe, expect, it } from "vitest";
import {
  classifyContainerOpError,
  cutoverTerminalStatus,
  restartFailuresMessage,
  rollbackTerminalStatus,
  runContainerOps,
  stopFailuresMessage,
} from "./migration-honesty";

describe("classifyContainerOpError", () => {
  it("treats already-there as benign for stop and start", () => {
    expect(classifyContainerOpError({ statusCode: 304 }, "stop")).toBe("benign");
    expect(classifyContainerOpError({ statusCode: 304 }, "start")).toBe("benign");
    expect(classifyContainerOpError(new Error("already started"), "start")).toBe("benign");
    expect(classifyContainerOpError(new Error("already stopped"), "stop")).toBe("benign");
  });

  it("treats a missing container as benign for stop/destroy and failed for start", () => {
    expect(classifyContainerOpError({ statusCode: 404 }, "stop")).toBe("benign");
    expect(classifyContainerOpError({ statusCode: 404 }, "destroy")).toBe("benign");
    expect(classifyContainerOpError(new Error("No such container: abc"), "stop")).toBe("benign");
    expect(classifyContainerOpError(new Error("container is not running"), "stop")).toBe("benign");

    expect(classifyContainerOpError({ statusCode: 404 }, "start")).toBe("failed");
    expect(classifyContainerOpError(new Error("No such container: abc"), "start")).toBe("failed");
    expect(classifyContainerOpError(new Error("volume not found"), "start")).toBe("failed");
  });

  it("treats a real stop/start failure as failed", () => {
    expect(classifyContainerOpError(new Error("permission denied"), "stop")).toBe("failed");
    expect(classifyContainerOpError(new Error("Cannot kill container: device or resource busy"), "stop")).toBe(
      "failed",
    );
  });
});

describe("runContainerOps — success-gating", () => {
  it("stop: returns only real failures, not 304/404", async () => {
    const failed = await runContainerOps(
      { web: "cid_web", db: "cid_db", gone: "cid_gone" },
      async (id) => {
        if (id === "cid_db") throw new Error("device or resource busy");
        if (id === "cid_gone") {
          const err = new Error("no such container") as Error & { statusCode: number };
          err.statusCode = 404;
          throw err;
        }
      },
      "stop",
    );
    expect(failed).toEqual([
      { name: "db", containerId: "cid_db", reason: "device or resource busy" },
    ]);
  });

  it("start: a missing source is a failed restore, not rolled_back", async () => {
    const failed = await runContainerOps(
      { web: "cid_web" },
      async () => {
        const err = new Error("no such container") as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      },
      "start",
    );
    expect(failed).toHaveLength(1);
    expect(rollbackTerminalStatus(failed)).toBe("failed");
  });

  it("returns empty when every op succeeds", async () => {
    expect(await runContainerOps({ web: "cid" }, async () => {}, "stop")).toEqual([]);
  });
});

describe("terminal status must not claim success", () => {
  const leftover = [{ name: "web", containerId: "abc123456789", reason: "busy" }];

  it("stop failures produce a consistency error, not a success line", () => {
    const msg = stopFailuresMessage(leftover);
    expect(msg).toMatch(/still running/);
    expect(msg).toContain("web (abc123456789");
  });

  it("a rollback that could not restart the source is failed, not rolled_back", () => {
    expect(rollbackTerminalStatus([])).toBe("rolled_back");
    expect(rollbackTerminalStatus(leftover)).toBe("failed");
    expect(restartFailuresMessage(leftover)).toMatch(/original stack is down/);
  });

  it("cutover that left source containers up is failed, not succeeded", () => {
    expect(cutoverTerminalStatus([])).toBe("succeeded");
    expect(cutoverTerminalStatus(leftover)).toBe("failed");
  });
});
