import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCommandOutput } from "./command-stream";

afterEach(() => vi.useRealTimers());

describe("command capture after stdout closes", () => {
  it.each(["cancel", "stderr error"] as const)(
    "stops the running command on %s even after its output reached EOF",
    async (failure) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const child = {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        onClose: new Promise<number>(() => {}),
        kill: vi.fn(),
      };
      const capture = captureCommandOutput(child, { signal: controller.signal });
      capture.stdout.resume();
      child.stdout.end("finished writing output");
      await finished(capture.stdout);
      expect(capture.stdout.readableEnded).toBe(true);

      const reason = new Error("The command must stop now");
      if (failure === "cancel") controller.abort(reason);
      else child.stderr.destroy(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(child.kill).toHaveBeenCalledOnce();
      await expect(capture.awaitExit).rejects.toBe(reason);
    },
  );
});
