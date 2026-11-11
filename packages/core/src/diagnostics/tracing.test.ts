import { afterEach, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  setDiagnosticTelemetry,
  startDiagnosticSpan,
  type DiagnosticTelemetry,
} from "./tracing";
import { currentErrorContext, withDiagnosticSpan } from "./node";
import { diagnosticContext } from "./reporter";

afterEach(() => {
  setDiagnosticTelemetry(undefined);
});

it("does not inspect local telemetry arguments when the Cloud host has not installed an observer", () => {
  const context = new Proxy(
    {},
    {
      get() {
        throw new Error("local data inspected");
      },
      ownKeys() {
        throw new Error("local data inspected");
      },
    },
  );
  expect(startDiagnosticSpan(context)).toBeUndefined();
  expect(() => emitDiagnosticEvent("project.created", context)).not.toThrow();
});

it("preserves application results and original failures when tracing startup or completion fails", async () => {
  const work = vi.fn(async () => "success");
  const brokenStart = {
    start() {
      throw new Error("observer failed");
    },
  } as unknown as DiagnosticTelemetry;
  setDiagnosticTelemetry(brokenStart);
  expect(await withDiagnosticSpan({}, work)).toBe("success");
  expect(work).toHaveBeenCalledOnce();
  const start = vi.fn(() => ({
    correlation: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    run: <T>(fn: () => T) => fn(),
    end() {
      throw new Error("exporter failed");
    },
  }));
  setDiagnosticTelemetry({ ...brokenStart, start });
  expect(await withDiagnosticSpan({}, async () => "value")).toBe("value");
  const failure = new Error("original application failure");
  await expect(
    withDiagnosticSpan({}, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(currentErrorContext()).toEqual({});
});

it("does not clear a replacement Cloud observer when an older host shuts down", () => {
  const first = { event: vi.fn() } as unknown as DiagnosticTelemetry;
  const second = { event: vi.fn() } as unknown as DiagnosticTelemetry;
  const stop = setDiagnosticTelemetry(first);
  setDiagnosticTelemetry(second);
  stop();
  emitDiagnosticEvent("project.created", {});
  expect(second.event).toHaveBeenCalledOnce();
  expect(first.event).not.toHaveBeenCalled();
});

it("allows bounded trace flags without invoking accessors from diagnostic context", () => {
  expect(diagnosticContext({ traceFlags: 1 })).toEqual({ traceFlags: 1 });
  for (const traceFlags of [-1, 256, NaN, 1.2])
    expect(diagnosticContext({ traceFlags })).toEqual({});
  expect(
    diagnosticContext({
      get traceFlags(): number {
        throw new Error("private accessor");
      },
    }),
  ).toEqual({});
});
