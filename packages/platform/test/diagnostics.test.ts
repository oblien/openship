import {
  errorReporter,
  reportError,
  type ErrorEvent,
} from "@repo/core/diagnostics";
import {
  currentErrorContext,
  withErrorContext,
} from "@repo/core/diagnostics/node";
import { beforeEach, describe, expect, it } from "vitest";
import { observePlatformOperations } from "../src/diagnostics";

const events: ErrorEvent[] = [];
beforeEach(async () => {
  await errorReporter.flush();
  events.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink((batch) => {
    events.push(...batch);
  });
});

describe("shared platform error boundary", () => {
  it("preserves synchronous values, receivers and the exact thrown error", async () => {
    const error = new Error("sync failure");
    const operations = {
      count: 4,
      read() {
        return this.count;
      },
      fail() {
        throw error;
      },
    };
    const observed = observePlatformOperations("projects", operations);
    expect(observed.read()).toBe(4);
    expect(() => observed.fail()).toThrow(error);
    await errorReporter.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.context.operation).toBe("projects.fail");
    expect(currentErrorContext()).toEqual({});
  });

  it("does not inspect arguments, mutate authority or retry a rejected operation", async () => {
    const authority = Object.freeze({
      userId: "a",
      organizationId: "org-a",
      traceId: "trace-a",
    });
    const failure = new Error("denied");
    let calls = 0;
    const operations = observePlatformOperations("services", {
      async deploy(ctx: typeof authority, input: { token: string }) {
        expect(ctx).toBe(authority);
        expect(input.token).toBe("private-request-913");
        calls++;
        throw failure;
      },
    });
    await expect(
      operations.deploy(authority, { token: "private-request-913" }),
    ).rejects.toBe(failure);
    await errorReporter.flush();
    expect(calls).toBe(1);
    expect(events[0]?.context).toMatchObject({
      userId: "a",
      organizationId: "org-a",
      operation: "services.deploy",
    });
    expect(JSON.stringify(events)).not.toContain("private-request-913");
  });

  it("retains each stream's authority after the HTTP request finishes and closes its source", async () => {
    const seen: string[] = [];
    const failure = new Error("stream failed");
    const operations = observePlatformOperations("jobs", {
      async events(ctx: { userId: string; organizationId: string }) {
        return {
          context: ctx,
          data: (async function* () {
            try {
              reportError("stream started", { severity: "info" });
              yield 1;
              throw failure;
            } finally {
              seen.push(ctx.userId);
            }
          })(),
        };
      },
    });
    const [a, b] = await Promise.all(
      ["a", "b"].map((id) =>
        withErrorContext(
          { requestId: `request-${id}` },
          () => operations.events({ userId: id, organizationId: `org-${id}` }),
          true,
        ),
      ),
    );
    const first = a!.data[Symbol.asyncIterator]();
    const second = b!.data[Symbol.asyncIterator]();
    expect(await first.next()).toEqual({ value: 1, done: false });
    expect(await second.next()).toEqual({ value: 1, done: false });
    await expect(first.next()).rejects.toBe(failure);
    await second.return?.();
    await errorReporter.flush();
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(
      events.find((event) => event.error.message === "stream failed")?.context,
    ).toMatchObject({
      requestId: "request-a",
      userId: "a",
      organizationId: "org-a",
      operation: "jobs.events",
    });
    expect(
      events.find((event) => event.context.userId === "b")?.context.requestId,
    ).toBe("request-b");
    expect(currentErrorContext()).toEqual({});
  });
});
