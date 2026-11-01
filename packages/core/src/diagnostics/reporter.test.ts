import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorReporter,
  errorReporter,
  reportCaughtError,
  type ErrorEvent,
  type ErrorSink,
  diagnosticError,
  redactDiagnosticText,
} from "./index";

afterEach(() => {
  vi.useRealTimers();
});

function recorder(options: ConstructorParameters<typeof ErrorReporter>[0] = {}) {
  const events: ErrorEvent[] = [];
  const sink: ErrorSink = (batch) => {
    events.push(...batch);
  };
  return {
    reporter: new ErrorReporter({
      sink,
      fallback: sink,
      flushIntervalMs: 0,
      ...options,
    }),
    events,
  };
}

describe("structured error reporting", () => {
  it("does not collect caught errors by default, even after installing a destination", async () => {
    const sink = vi.fn();
    const touched = vi.fn();
    const error = new Proxy({}, { getOwnPropertyDescriptor: touched });
    errorReporter.setSink(sink);
    expect(errorReporter.isEnabled()).toBe(false);
    reportCaughtError(error, "self-hosted/probe");
    expect(errorReporter.capture(error)).toBe("");
    await errorReporter.flush();
    expect(touched).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(errorReporter.stats().queued).toBe(0);
  });

  it("keeps intentional errors local when collection is disabled", async () => {
    const local = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reporter, events } = recorder({ enabled: false });
    try {
      reporter.log("error", "desktop", "Connection failed", new Error("password=private-913"));
      await reporter.flush();
      expect(events).toHaveLength(0);
      expect(local).toHaveBeenCalledTimes(1);
      expect(JSON.parse(local.mock.calls[0]![0]).context.component).toBe("desktop");
      expect(local.mock.calls[0]![0]).not.toContain("private-913");
    } finally {
      local.mockRestore();
    }
  });

  it("writes local diagnostics without accessing Node streams in a browser or Edge runtime", () => {
    const output = vi.spyOn(process, "stderr", "get").mockImplementation(() => {
      throw new Error("Node streams are unavailable in Edge");
    });
    const local = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reporter = new ErrorReporter({ enabled: false });
      reporter.log("warn", "dashboard", "Portable diagnostic");
      expect(output).not.toHaveBeenCalled();
      expect(local).toHaveBeenCalledOnce();
      expect(JSON.parse(local.mock.calls[0]![0])).toMatchObject({
        error: { message: "Portable diagnostic" },
        context: { component: "dashboard" },
      });
    } finally {
      output.mockRestore();
      local.mockRestore();
    }
  });

  it("discards pending events and their identities when disabled", async () => {
    const { reporter, events } = recorder();
    const error = new Error("same object");
    const oldId = reporter.capture(error);
    reporter.setEnabled(false);
    reporter.capture(new Error("private local failure"));
    await reporter.flush();
    expect(events).toHaveLength(0);
    reporter.setEnabled(true);
    const newId = reporter.capture(error);
    await reporter.flush();
    expect(newId).not.toBe(oldId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(newId);
  });

  it("cancels in-flight delivery without replaying it after re-enabling", async () => {
    const fallback = vi.fn();
    const aborted = vi.fn();
    const sink = vi.fn<ErrorSink>().mockImplementationOnce(
      (_events, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const { reporter } = recorder({ sink, fallback });
    reporter.capture("old event");
    const flushing = reporter.flush();
    await Promise.resolve();
    reporter.setEnabled(false);
    reporter.setEnabled(true);
    await flushing;
    expect(aborted).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(reporter.stats()).toMatchObject({ delivered: 0, deliveryFailures: 0 });
    reporter.capture("new event");
    await reporter.flush();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]![0][0]!.error.message).toBe("new event");
    expect(reporter.stats().delivered).toBe(1);
  });

  it("fails closed for unavailable configuration and checks it again before delivery", async () => {
    let enabled = false;
    const { reporter, events } = recorder({ enabled: () => enabled });
    reporter.capture("before configuration");
    enabled = true;
    reporter.capture("queued while enabled");
    enabled = false;
    await reporter.flush();
    enabled = true;
    await reporter.flush();
    expect(events).toHaveLength(0);
    reporter.setEnabled(() => {
      throw new Error("config unavailable");
    });
    expect(() => reporter.capture(new Error("private"))).not.toThrow();
    expect(reporter.isEnabled()).toBe(false);
  });

  it.each([
    "https://api.telegram.org/bot123456789:AAprivate913xyz00000000000000000/sendMessage",
    "https://discord.com/api/webhooks/123456789/private-webhook-913",
    "https://hooks.slack.com/services/T12345/B12345/private-webhook-913",
    "certbot --eab-hmac-key private-acme-913 --eab-kid private-kid-913",
    "eab_hmac_key=private-acme-913",
  ])("redacts provider credential paths and ACME enrollment values: %s", (message) => {
    expect(redactDiagnosticText(message)).not.toContain("private");
  });

  it("does not invoke value coercion or overridden AggregateError array methods", () => {
    const touched = vi.fn(() => "private-value");
    const error = new Error("Failure");
    Object.defineProperty(error, "message", { value: { toString: touched } });
    const errors = [new Error("nested")];
    Object.defineProperty(errors, "0", { get: touched });
    Object.defineProperty(errors, "slice", { value: touched });
    Object.defineProperty(error, "errors", { value: errors });
    expect(diagnosticError(error).message).toBe("Unknown error");
    expect(touched).not.toHaveBeenCalled();

    const inherited = new Error("Failure");
    let prototype = Object.create(Error.prototype, { name: { get: touched } });
    for (let depth = 0; depth < 6; depth++) prototype = Object.create(prototype);
    Object.setPrototypeOf(inherited, prototype);
    diagnosticError(inherited);
    expect(touched).not.toHaveBeenCalled();
  });

  it("reads only allowed context data and lets a child clear inherited identity", async () => {
    const touched = vi.fn(() => "private-value");
    const { reporter, events } = recorder({ context: () => ({ userId: "parent-user" }) });
    reporter.capture(new Error("Failure"), {
      userId: undefined,
      requestId: "child-request",
      get password() {
        return touched();
      },
    } as Parameters<typeof reporter.capture>[1]);
    await reporter.flush();
    expect(events[0]!.context.requestId).toBe("child-request");
    expect(events[0]!.context.userId).toBeUndefined();
    expect(touched).not.toHaveBeenCalled();
  });

  it("redacts both WebAuthn challenge values in a verifier error", () => {
    expect(
      redactDiagnosticText(
        'Unexpected authentication response challenge "challenge-private-913", expected "expected-private-913"',
      ),
    ).toBe("Unexpected authentication response challenge [REDACTED]");
  });

  it("captures redacted errors, causes and request identifiers without serializing provider payloads", async () => {
    const { reporter, events } = recorder();
    const error = Object.assign(
      new Error("Upstream failed", {
        cause: new Error("Authorization: Bearer top-secret"),
      }),
      {
        statusCode: 502,
        code: "PROVIDER_FAILED",
        config: { password: "provider-secret" },
        request: { body: "customer-body" },
      },
    );
    reporter.capture(error, {
      requestId: "request-1",
      organizationId: "org-1",
      userId: "user-1",
      route: "/api/billing?token=secret",
      kind: "http",
    });
    expect(events).toHaveLength(0);
    await reporter.flush();
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      category: "dependency",
      severity: "error",
      context: {
        requestId: "request-1",
        organizationId: "org-1",
        route: "/api/billing",
        statusCode: 502,
      },
    });
    expect(events[0]!.error.cause?.message).toBe("[REDACTED HEADER]");
    expect(JSON.stringify(events)).not.toMatch(
      /provider-secret|customer-body|top-secret|token=secret/,
    );
  });

  it.each([
    [401, "authentication", "warn"],
    [403, "authorization", "warn"],
    [404, "not_found", "warn"],
    [400, "validation", "warn"],
    [409, "conflict", "warn"],
    [429, "rate_limit", "warn"],
    [402, "billing", "warn"],
    [500, "internal", "error"],
    [504, "timeout", "error"],
  ])("classifies HTTP %s consistently", async (statusCode, category, severity) => {
    const { reporter, events } = recorder();
    reporter.capture("Failure", { statusCode: statusCode as number });
    await reporter.flush();
    expect(events[0]).toMatchObject({ category, severity });
  });

  it("does not invoke getters, toJSON or toString on an arbitrary thrown object", async () => {
    const { reporter, events } = recorder();
    const getter = vi.fn(() => {
      throw new Error("should not run");
    });
    const error = {
      get password() {
        return getter();
      },
      get message() {
        return getter();
      },
      get stack() {
        return getter();
      },
      toJSON: getter,
      toString: getter,
    };
    expect(() => reporter.capture(error)).not.toThrow();
    const trap = () => {
      throw new Error("hostile proxy");
    };
    expect(() =>
      reporter.capture(new Proxy({}, { getOwnPropertyDescriptor: trap, getPrototypeOf: trap })),
    ).not.toThrow();
    await reporter.flush();
    expect(events[0]!.error.message).toBe("Unknown error");
    expect(error.toJSON).not.toHaveBeenCalled();
  });

  it("bounds circular causes and huge AggregateErrors", async () => {
    const { reporter, events } = recorder();
    const error = new Error("a".repeat(100_000));
    error.cause = error;
    reporter.capture(error);
    reporter.capture(
      new AggregateError(
        Array.from({ length: 1000 }, () => error),
        "bulk",
      ),
    );
    await reporter.flush();
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(JSON.stringify(event).length * 2).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(events)).toContain("circular cause");
  });

  it("does not invoke message getters indirectly while formatting a native Error stack", async () => {
    const { reporter, events } = recorder();
    const getter = vi.fn(() => "private-getter-913");
    const error = new Error("failed");
    Object.defineProperty(error, "message", { get: getter });
    reporter.capture(error);
    await reporter.flush();
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("private-getter-913");
  });

  it("does not mistake a bound application stack getter for a native formatter", async () => {
    const { reporter } = recorder();
    const getter = vi.fn(() => "private-getter-913");
    const error = new Error("failed");
    Object.defineProperty(error, "stack", { get: getter.bind(null) });
    reporter.capture(error);
    await reporter.flush();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not accumulate promises from an incorrectly asynchronous fallback", async () => {
    const local = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fallback = vi.fn(() => new Promise<void>(() => {}));
      const reporter = new ErrorReporter({
        sink: () => {
          throw new Error("offline");
        },
        fallback,
      });
      for (let i = 0; i < 5; i++) {
        reporter.capture(`failure-${i}`);
        await reporter.flush();
      }
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(local).toHaveBeenCalled();
    } finally {
      local.mockRestore();
    }
  });

  it("drains all batches without leaving an idle timer behind", async () => {
    vi.useFakeTimers();
    const { reporter, events } = recorder({ batchSize: 2 });
    for (let i = 0; i < 10; i++) reporter.capture(`failure-${i}`);
    expect(await reporter.flush()).toBe(true);
    expect(events).toHaveLength(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an old timeout disable a newly configured destination", async () => {
    const old = vi.fn(() => new Promise<void>(() => {}));
    const replacement = vi.fn();
    const { reporter } = recorder({ sink: old, deliveryTimeoutMs: 10 });
    reporter.capture("old event");
    const flushing = reporter.flush();
    await Promise.resolve();
    reporter.setSink(replacement);
    await flushing;
    reporter.capture("new event");
    await reporter.flush();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement.mock.calls[0]?.[0][0].error.message).toBe("new event");
  });

  it("classifies native aborts as expected cancellation and preserves source file names", async () => {
    const { reporter, events } = recorder();
    reporter.capture(new DOMException("The user cancelled", "AbortError"));
    await reporter.flush();
    expect(events[0]).toMatchObject({
      category: "cancelled",
      severity: "info",
    });
    expect(redactDiagnosticText("at login (/app/token.service.ts:12:4)")).toContain(
      "token.service.ts:12:4",
    );
  });

  it("retains sanitized provider references without serializing billing payloads", async () => {
    const { reporter, events } = recorder();
    reporter.log("warn", "billing", "Provider request failed", {
      method: "POST",
      operation: "/billing/checkout/:id",
      providerStatus: 503,
      providerCode: "storage_unavailable",
      reference: "provider-123",
      retryable: false,
      body: { clientSecret: "protected-billing-913" },
      namespace: "customer-namespace",
    });
    await reporter.flush();
    expect(events[0]).toMatchObject({
      category: "dependency",
      context: {
        providerStatus: 503,
        providerCode: "storage_unavailable",
        providerRequestId: "provider-123",
        retryable: false,
      },
    });
    expect(JSON.stringify(events)).not.toMatch(
      /protected-billing-913|customer-namespace|clientSecret/,
    );
  });

  it("deduplicates a repeated observation but keeps separate request failures and links boundaries", async () => {
    const { reporter, events } = recorder();
    const error = new Error("failed");
    const first = reporter.capture(error, {
      requestId: "request-1",
      kind: "operation",
      operation: "deploy",
    });
    expect(
      reporter.capture(error, {
        requestId: "request-1",
        kind: "operation",
        operation: "deploy",
      }),
    ).toBe(first);
    reporter.capture(error, { requestId: "request-1", kind: "http" });
    reporter.capture(error, { requestId: "request-2", kind: "http" });
    await reporter.flush();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.errorId)).size).toBe(1);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
  });

  it("classifies build disk exhaustion and nested connection failures", async () => {
    const { reporter, events } = recorder();
    reporter.capture(new Error("Docker build failed: no space left on device"), {
      kind: "deployment",
    });
    reporter.capture(
      new TypeError("fetch failed", {
        cause: new AggregateError([
          Object.assign(new Error("socket refused"), { code: "ECONNREFUSED" }),
        ]),
      }),
    );
    await reporter.flush();
    expect(events.map((event) => event.category)).toEqual(["storage", "network"]);
  });

  it("snapshots context before asynchronous delivery and ignores undeclared fields", async () => {
    const { reporter, events } = recorder();
    const context = {
      userId: "user-a",
      organizationId: "org-a",
      headers: { authorization: "secret" },
      body: "private",
      sessionId: "session-secret",
    };
    reporter.capture("failed", context);
    context.userId = "user-b";
    await reporter.flush();
    expect(events[0]!.context.userId).toBe("user-a");
    expect(JSON.stringify(events)).not.toMatch(/secret|private|headers|sessionId/);
  });

  it("never waits for a slow sink and bounds overload with a visible loss count", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { reporter, events } = recorder({
      maxEvents: 3,
      batchSize: 1,
      sink: async (batch) => {
        await blocked;
        events.push(...batch);
      },
    });
    for (let i = 0; i < 50; i++) reporter.capture(`failure ${i}`);
    expect(reporter.stats().queued).toBe(3);
    expect(reporter.stats().dropped).toBe(47);
    expect(await reporter.flush(10)).toBe(false);
    release();
    expect(await reporter.flush()).toBe(true);
    expect(
      events.find((event) => event.error.code === "DIAGNOSTICS_OVERFLOW")?.error.message,
    ).toContain("47");
    expect(reporter.stats().queuedBytes).toBe(0);
  });

  it("falls back without throwing, recursive errors or unhandled rejections", async () => {
    const fallback = vi.fn();
    const sink = vi.fn(async () => {
      throw new Error("Transport secret=private failed");
    });
    const reporter = new ErrorReporter({ sink, fallback, flushIntervalMs: 0 });
    for (let i = 0; i < 5; i++) {
      reporter.capture(`failure ${i}`);
      await reporter.flush();
    }
    expect(sink).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(fallback.mock.calls)).not.toContain("private");
    expect(reporter.stats().deliveryFailures).toBe(3);
  });

  it("opens the circuit for a destination ignoring cancellation instead of leaking more pending calls", async () => {
    const sink = vi.fn(() => new Promise<void>(() => {}));
    const fallback = vi.fn();
    const reporter = new ErrorReporter({
      sink,
      fallback,
      deliveryTimeoutMs: 10,
      flushIntervalMs: 0,
    });
    reporter.capture("first");
    await reporter.flush(100);
    reporter.capture("second");
    await reporter.flush(100);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("keeps diagnostic output bounded when a destination and fallback both throw", async () => {
    const reporter = new ErrorReporter({
      sink: () => {
        throw new Error("sink");
      },
      fallback: () => {
        throw new Error("fallback");
      },
    });
    expect(() => reporter.capture("failed")).not.toThrow();
    expect(await reporter.flush()).toBe(true);
  });

  it("uses the same redaction for an emergency write even with a full buffer", () => {
    const { reporter } = recorder({ maxEvents: 1 });
    reporter.capture("queue is full");
    const output: ErrorEvent[] = [];
    reporter.emergency(
      new Error("password=protected-value-913"),
      { kind: "process", severity: "fatal" },
      (event) => {
        output.push(event);
      },
    );
    expect(output[0]?.severity).toBe("fatal");
    expect(JSON.stringify(output)).not.toContain("protected-value-913");
  });
});

describe("diagnostic privacy", () => {
  it("does not allow a credential disguised as an error code to bypass redaction", () => {
    const error = Object.assign(new Error("failed"), {
      code: "sk_live_privatecredential913",
    });
    expect(diagnosticError(error).code).toBeUndefined();
    expect(JSON.stringify(diagnosticError(error))).not.toContain("privatecredential913");
  });

  it.each([
    "https://user:password@host/path?token=private#secret",
    "postgres://user:password@host/database?password=secret",
    "password='private'",
    'secret="private"',
    "GITHUB_PRIVATE_KEY=private",
    "apiKey: private",
    "Authorization: Bearer private",
    "Cookie: session=private",
    "ghp_12345678901234567890",
    "sk_12345678901234567890",
    "oblien_12345678901234567890",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nprivate",
    "/accept-invite/private",
    "/api/auth/invitation-preview/private",
    "Failed query: SELECT private FROM secrets; params: secret",
    "person@example.com",
  ])("redacts %s", (text) => {
    const result = redactDiagnosticText(text);
    expect(result).not.toMatch(
      /private|password@|token=|12345678901234567890|person@example\.com|params: secret/,
    );
  });

  it("retains useful code, stack frames and cause instead of arbitrary SDK fields", () => {
    const root = Object.assign(new Error("Socket refused"), {
      code: "ECONNREFUSED",
      authorization: "protected-value-913",
    });
    const error = new Error("Deployment failed", { cause: root });
    expect(diagnosticError(error).cause).toMatchObject({
      name: "Error",
      message: "Socket refused",
      code: "ECONNREFUSED",
    });
    expect(diagnosticError(error).stack).toContain("reporter.test");
    expect(JSON.stringify(diagnosticError(error))).not.toContain("protected-value-913");
  });
});
