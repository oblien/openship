import { describe, expect, it, vi } from "vitest";
import { createLogMessageProcessor } from "./sseMessageProcessors";

function harness() {
  const onContainerExit = vi.fn();
  const processor = createLogMessageProcessor({ onContainerExit });
  const feed = (data: Record<string, unknown>) => {
    const parsed = processor.parseMessage({ type: "end", ...data });
    processor.handleMessage(parsed as any, { rawText: "", rawBytes: undefined } as any);
  };
  return { feed, onContainerExit };
}

describe("log processor end frames", () => {
  it("notifies on a quiet stop with exit code 0", () => {
    const { feed, onContainerExit } = harness();
    feed({ exitCode: 0, message: "Log stream ended" });
    expect(onContainerExit).toHaveBeenCalledWith(0, "Log stream ended");
  });

  it("notifies on a crash with the server message", () => {
    const { feed, onContainerExit } = harness();
    feed({ exitCode: 137, message: "Container exited" });
    expect(onContainerExit).toHaveBeenCalledWith(137, "Container exited");
  });

  it("synthesizes a crash message when none is provided", () => {
    const { feed, onContainerExit } = harness();
    feed({ exitCode: 1 });
    expect(onContainerExit).toHaveBeenCalledWith(1, "Container exited with code 1");
  });

  it("defaults an absent exit code to a clean close", () => {
    const { feed, onContainerExit } = harness();
    feed({});
    expect(onContainerExit).toHaveBeenCalledWith(0, "Log stream ended");
  });
});
