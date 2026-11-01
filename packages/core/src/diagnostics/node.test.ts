import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import {
  consoleErrorSink,
  errorReporter,
  reportError,
  reportCaughtError,
  type ErrorEvent,
} from "./index";
import {
  currentErrorContext,
  enrichErrorContext,
  observeBackground,
  withErrorContext,
  writableErrorSink,
} from "./node";

const events: ErrorEvent[] = [];
beforeEach(async () => {
  await errorReporter.flush();
  events.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink((batch) => {
    events.push(...batch);
  });
});
afterEach(async () => {
  await errorReporter.flush();
  errorReporter.setEnabled(false);
});

describe("scoped diagnostic context", () => {
  it("does not report normal Next rendering bailouts as application failures", async () => {
    for (const digest of [
      "NEXT_REDIRECT;replace;/login;307;",
      "NEXT_HTTP_ERROR_FALLBACK;404",
      "DYNAMIC_SERVER_USAGE",
      "BAILOUT_TO_CLIENT_SIDE_RENDERING",
      "NEXT_PRERENDER_INTERRUPTED",
    ]) {
      reportCaughtError(
        Object.assign(new Error("framework control flow"), { digest }),
        "dashboard",
      );
    }
    await errorReporter.flush();
    expect(events).toHaveLength(0);
    reportCaughtError(Object.assign(new Error("real failure"), { digest: "123456" }), "dashboard");
    await errorReporter.flush();
    expect(events).toHaveLength(1);
  });

  it("bounds the last-resort output when stderr stalls and reports the lost count after recovery", async () => {
    reportError("safe event");
    await errorReporter.flush();
    const output = {
      destroyed: false,
      writable: true,
      writableNeedDrain: true,
      writableLength: 65_536,
    };
    const stderr = vi
      .spyOn(process, "stderr", "get")
      .mockReturnValue(output as typeof process.stderr);
    const consoleWrite = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let index = 0; index < 100; index++)
        consoleErrorSink(events, new AbortController().signal);
      expect(consoleWrite).not.toHaveBeenCalled();
      output.writableNeedDrain = false;
      output.writableLength = 0;
      consoleErrorSink(events, new AbortController().signal);
      expect(consoleWrite).toHaveBeenCalledTimes(2);
      expect(JSON.parse(consoleWrite.mock.calls[0]![0])).toMatchObject({
        error: {
          code: "DIAGNOSTICS_OUTPUT_DROPPED",
          message: "100 diagnostic events were dropped while the local output was unavailable.",
        },
      });
      expect(JSON.parse(consoleWrite.mock.calls[1]![0]).error.message).toBe("safe event");
    } finally {
      stderr.mockRestore();
      consoleWrite.mockRestore();
    }
  });

  it("never leaks identity across concurrent operations or back to the caller", async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        withErrorContext({ userId: `user-${index}`, requestId: `request-${index}` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, index % 4));
          enrichErrorContext({ organizationId: `org-${index}` });
          reportError(`failure-${index}`);
        }),
      ),
    );
    await errorReporter.flush();
    expect(events).toHaveLength(40);
    for (const event of events) {
      const index = event.error.message.slice("failure-".length);
      expect(event.context).toMatchObject({
        userId: `user-${index}`,
        organizationId: `org-${index}`,
        requestId: `request-${index}`,
      });
    }
    expect(currentErrorContext()).toEqual({});
  });

  it("starts a cron job with a fresh identity and preserves its rejection", async () => {
    const error = new Error("job failed");
    await withErrorContext(
      {
        userId: "request-user",
        requestId: "request-id",
        organizationId: "wrong-org",
      },
      async () => {
        await expect(
          observeBackground({ jobId: "job-1", organizationId: "job-org" }, async () => {
            throw error;
          }),
        ).rejects.toBe(error);
        expect(currentErrorContext().userId).toBe("request-user");
      },
    );
    await errorReporter.flush();
    expect(events[0]!.context).toMatchObject({
      kind: "background",
      jobId: "job-1",
      organizationId: "job-org",
    });
    expect(events[0]!.context.userId).toBeUndefined();
    expect(events[0]!.context.requestId).toBeUndefined();
  });

  it("writes one JSON line per event and respects writable backpressure", async () => {
    const chunks: string[] = [];
    let written!: () => void;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        written = callback;
      },
    });
    const sink = writableErrorSink(output);
    const controller = new AbortController();
    let finished = false;
    reportError("first");
    await errorReporter.flush();
    const pending = Promise.resolve(sink(events, controller.signal)).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    written();
    await pending;
    expect(chunks[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(chunks[0]!.trim()).error.message).toBe("first");
    expect(output.listenerCount("error")).toBe(1);
    writableErrorSink(output);
    expect(output.listenerCount("error")).toBe(1);
  });

  it("contains a failed output stream, including its late error event", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("broken log pipe"));
      },
    });
    const sink = writableErrorSink(output);
    reportError("application failure");
    await errorReporter.flush();
    await expect(sink(events, new AbortController().signal)).rejects.toThrow("broken log pipe");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.listenerCount("error")).toBe(1);
  });
});
