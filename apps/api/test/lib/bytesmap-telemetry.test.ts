import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  ErrorReporter,
  emitDiagnosticEvent,
  errorReporter,
  reportError,
  setDiagnosticTelemetry,
  type ErrorEvent,
} from "@repo/core/diagnostics";
import {
  currentErrorContext,
  enrichErrorContext,
  observeBackground,
  withDiagnosticSpan,
} from "@repo/core/diagnostics/node";
import { observePlatformOperations } from "../../../../packages/platform/src/diagnostics";
import { audit } from "../../../../packages/platform/src/engine/lib/audit-emitter";
import {
  drainErrorResponses,
  noteApiError,
  observeRequestErrors,
} from "../../src/middleware/error-observation";
import { resolveBytesMapTelemetry } from "../../src/lib/bytesmap-telemetry-config";
import { createBytesMapTelemetry, type BytesMapTelemetry } from "../../src/lib/bytesmap-telemetry";

const { createAudit } = vi.hoisted(() => ({ createAudit: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { auditEvent: { create: createAudit } } }));

let server: Server;
let telemetry: BytesMapTelemetry;
let endpoint: string;
let unavailable: boolean;
const observations: ErrorEvent[] = [];
const exports: {
  path: string;
  dataset: string | null;
  headers: Record<string, unknown>;
  body: any;
}[] = [];
const token = "bmap_event_" + "t".repeat(43);
const dataset = "3df4c77e-d825-427d-9b23-f281d65a4d03";
const config = {
  endpoint: "https://events.example.test",
  token,
  dataset,
  sampleRate: 1,
  environment: "test",
};

beforeEach(async () => {
  exports.length = 0;
  observations.length = 0;
  createAudit
    .mockReset()
    .mockImplementation(async ({ resourceId }) => ({ id: `audit-${resourceId}` }));
  unavailable = false;
  server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    exports.push({
      path: new URL(request.url!, endpoint).pathname,
      dataset: new URL(request.url!, endpoint).searchParams.get("dataset"),
      headers: request.headers,
      body: JSON.parse(Buffer.concat(parts).toString()),
    });
    response.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The in-process fixture uses loopback HTTP. Production resolves the HTTPS-only configuration below.
  telemetry = createBytesMapTelemetry({ ...config, endpoint }, "fixture-version", {
    allowPlaintextLoopback: true,
  });
  telemetry.install();
  errorReporter.setEnabled(true);
  errorReporter.setSink((events) => {
    observations.push(...events);
  });
});

afterEach(async () => {
  await errorReporter.flush();
  await telemetry.close();
  errorReporter.setEnabled(false);
  errorReporter.setObserver(undefined);
  setDiagnosticTelemetry(undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function spans(): any[] {
  return exports
    .filter((item) => item.path === "/v1/traces")
    .flatMap((item) =>
      item.body.resourceSpans.flatMap((resource: any) =>
        resource.scopeSpans.flatMap((scope: any) => scope.spans),
      ),
    );
}
function logs(): any[] {
  return exports
    .filter((item) => item.path === "/v1/logs")
    .flatMap((item) =>
      item.body.resourceLogs.flatMap((resource: any) =>
        resource.scopeLogs.flatMap((scope: any) => scope.logRecords),
      ),
    );
}
function attrs(record: any): Record<string, unknown> {
  return Object.fromEntries(
    record.attributes.map((attribute: any) => [
      attribute.key,
      attribute.value.stringValue ??
        attribute.value.intValue ??
        attribute.value.boolValue ??
        attribute.value.doubleValue,
    ]),
  );
}

describe("Cloud-only BytesMap telemetry configuration", () => {
  it("ignores configuration outside Cloud, including an explicitly connected desktop", () => {
    for (const mode of [
      { CLOUD_MODE: false, DEPLOY_MODE: "docker" },
      { CLOUD_MODE: true, DEPLOY_MODE: "desktop" },
      { CLOUD_MODE: true, OPENSHIP_BYTESMAP_ENABLED: false },
    ]) {
      const input = {
        OPENSHIP_BYTESMAP_ENABLED: true,
        ...mode,
        OPENSHIP_BYTESMAP_SAMPLE_RATE: "invalid-but-disabled",
        get OPENSHIP_BYTESMAP_TOKEN(): string {
          throw new Error("local credentials must not be read");
        },
      };
      expect(resolveBytesMapTelemetry(input)).toBeNull();
    }
    expect(
      resolveBytesMapTelemetry({
        CLOUD_MODE: true,
        OPENSHIP_BYTESMAP_ENABLED: true,
        OPENSHIP_BYTESMAP_ENDPOINT: config.endpoint,
        OPENSHIP_BYTESMAP_DATASET: dataset,
        OPENSHIP_BYTESMAP_TOKEN: token,
      }),
    ).toMatchObject({ ...config, environment: "production" });
  });

  it("refuses plaintext, URL credentials/paths/queries, malformed dataset IDs and invalid sampling", () => {
    const base = {
      CLOUD_MODE: true,
      OPENSHIP_BYTESMAP_ENABLED: true,
      OPENSHIP_BYTESMAP_ENDPOINT: config.endpoint,
      OPENSHIP_BYTESMAP_DATASET: dataset,
      OPENSHIP_BYTESMAP_TOKEN: token,
    };
    for (const endpoint of [
      "http://localhost:4317",
      "https://key:secret@example.test",
      "https://example.test/v1/traces",
      "https://example.test?token=secret",
      "https://example.test#fragment",
    ])
      expect(() =>
        resolveBytesMapTelemetry({ ...base, OPENSHIP_BYTESMAP_ENDPOINT: endpoint }),
      ).toThrow();
    for (const rate of [-0.1, 1.1, Infinity, NaN, "invalid", ""])
      expect(() =>
        resolveBytesMapTelemetry({ ...base, OPENSHIP_BYTESMAP_SAMPLE_RATE: rate }),
      ).toThrow();
    expect(() =>
      resolveBytesMapTelemetry({ ...base, OPENSHIP_BYTESMAP_DATASET: "other-tenant" }),
    ).toThrow();
  });
});

describe("BytesMap SDK traces, logs and operational events", () => {
  it("flushes a multi-batch burst without rejecting its own buffered exports", async () => {
    await Promise.all(
      Array.from({ length: 96 }, (_, index) =>
        withDiagnosticSpan({ operation: "projects.create" }, async () => {
          await audit.record(
            { organizationId: "org-a" },
            {
              eventType: "project.created",
              resourceType: "project",
              resourceId: `project-${index}`,
            },
          );
        }),
      ),
    );
    await telemetry.flush();
    expect(telemetry.status().exportFailures).toBe(0);
    expect(spans()).toHaveLength(96);
    expect(logs()).toHaveLength(96);
  });
  it("correlates concurrent authenticated HTTP, platform spans, errors and lifecycle facts without raw request data", async () => {
    const operations = observePlatformOperations("deployments", {
      async start(actor: { userId: string; organizationId: string; traceId: string }) {
        await new Promise((resolve) => setTimeout(resolve, actor.userId === "user-a" ? 15 : 1));
        await audit.record(
          { organizationId: actor.organizationId, actorUserId: actor.userId },
          {
            eventType: "deployment.created",
            resourceType: "deployment",
            resourceId: actor.userId,
            after: { password: "private-audit-value" },
          },
        );
        if (actor.userId === "user-a")
          throw new Error("provider failed password=private-error-value");
        return "accepted";
      },
    });
    const app = new Hono();
    app.use("*", observeRequestErrors);
    app.onError((error, c) => {
      noteApiError(c, error);
      return c.json({ error: "Deployment unavailable" }, 500);
    });
    app.get("/projects/:id", async (c) => {
      // This models established authorization, never identity taken from caller headers.
      const id = c.req.param("id") === "a" ? "a" : "b";
      const actor = {
        userId: `user-${id}`,
        organizationId: `org-${id}`,
        traceId: currentErrorContext().traceId!,
      };
      c.set("ctx", actor);
      enrichErrorContext(actor);
      return c.json(await operations.start(actor));
    });
    const [failed, ok] = await Promise.all([
      app.request("/projects/a?token=private-query-value", {
        headers: {
          traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
          authorization: "Bearer private-request-value",
          "x-organization-id": "spoofed-organization",
        },
      }),
      app.request("/projects/b?email=private-email-value"),
    ]);
    expect([failed.status, ok.status]).toEqual([500, 200]);
    await errorReporter.flush();
    await telemetry.flush();
    const roots = spans().filter((span) => span.name === "GET /projects/:id");
    const children = spans().filter((span) => span.name === "deployments.start");
    expect(roots).toHaveLength(2);
    expect(children).toHaveLength(2);
    const rootA = roots.find((span) => attrs(span).workspace_id === "org-a")!;
    expect(rootA.traceId).toBe("a".repeat(32));
    expect(rootA.parentSpanId).toBe("b".repeat(16));
    expect(rootA.status.code).toBe(2);
    for (const child of children) {
      const root = roots.find((root) => root.traceId === child.traceId)!;
      expect(child.parentSpanId).toBe(root.spanId);
      expect(attrs(child).workspace_id).toBe(attrs(root).workspace_id);
    }
    const facts = logs().filter((log) => attrs(log).event_name === "deployment.created");
    expect(facts).toHaveLength(2);
    expect(facts.map((log) => attrs(log).observation_id).sort()).toEqual([
      "audit-user-a",
      "audit-user-b",
    ]);
    const errors = logs().filter((log) => attrs(log).event_name === "openship.error");
    // The existing operation and HTTP boundaries observe one failure. Each observation exports once.
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((event) => event.errorId)).size).toBe(1);
    expect(errors.map((log) => attrs(log).observation_id).sort()).toEqual(
      observations.map((event) => event.eventId).sort(),
    );
    expect(spans().flatMap((span) => span.events ?? [])).toEqual([]);
    expect(
      errors.every((log) => log.traceId === rootA.traceId && attrs(log).workspace_id === "org-a"),
    ).toBe(true);
    const serialized = JSON.stringify(exports.map((item) => item.body));
    for (const privateValue of [
      "private-query-value",
      "private-email-value",
      "private-request-value",
      "private-error-value",
      "private-audit-value",
      "spoofed-organization",
      token,
    ])
      expect(serialized).not.toContain(privateValue);
    expect(serialized).toContain("[REDACTED CREDENTIAL]");
    expect(
      exports.every(
        (item) => item.headers.authorization === `Bearer ${token}` && item.dataset === dataset,
      ),
    ).toBe(true);
    expect(currentErrorContext()).toEqual({});
  });

  it("exports no audit fact when recording is disabled or the audit write fails", async () => {
    createAudit.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("audit unavailable"));
    for (const resourceId of ["disabled", "failed"])
      await audit.record(
        { organizationId: "org-a" },
        { eventType: "project.created", resourceType: "project", resourceId },
      );
    await errorReporter.flush();
    await telemetry.flush();
    expect(logs().filter((log) => attrs(log).event_name === "project.created")).toEqual([]);
    expect(logs().filter((log) => attrs(log).event_name === "openship.error")).toHaveLength(1);
  });

  it("retains client error diagnostics without counting a rejected request as a server failure", async () => {
    const app = new Hono();
    app.use("*", observeRequestErrors);
    app.onError((error, context) => {
      noteApiError(context, error);
      return context.json(
        { error: error.message },
        context.req.param("status") === "400" ? 400 : 503,
      );
    });
    app.get("/failures/:status", () => {
      throw new Error("Request failed");
    });
    const responses = await Promise.all([
      app.request("/failures/400"),
      app.request("/failures/503"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 503]);
    await errorReporter.flush();
    await telemetry.flush();
    const roots = spans();
    expect(roots).toHaveLength(2);
    expect(roots.find((span) => Number(attrs(span).status_code) === 400).status?.code ?? 0).toBe(0);
    expect(roots.find((span) => Number(attrs(span).status_code) === 503).status.code).toBe(2);
    expect(logs().filter((log) => attrs(log).event_name === "openship.error")).toHaveLength(2);
  });

  it.each([200, 400, 503] as const)(
    "uses the final HTTP %i response after a reported error or failed lifecycle event",
    async (status) => {
      const app = new Hono();
      app.use("*", observeRequestErrors);
      app.get("/reported", (context) => {
        reportError(new Error("Handled downstream failure"), { handled: true });
        return context.json({ result: "handled" }, status);
      });
      app.get("/lifecycle", (context) => {
        emitDiagnosticEvent("deployment.failed", { deploymentId: "deploy-a" });
        return context.json({ result: "recorded" }, status);
      });

      const responses = await Promise.all([
        app.request("/reported"),
        app.request("/lifecycle"),
      ]);
      expect(responses.map((response) => response.status)).toEqual([status, status]);
      await drainErrorResponses();
      await errorReporter.flush();
      await telemetry.flush();

      const roots = spans();
      expect(roots).toHaveLength(2);
      for (const root of roots) {
        expect(Number(attrs(root).http_status_code)).toBe(status);
        expect(root.status?.code ?? 0).toBe(status >= 500 ? 2 : 0);
      }
      for (const [event, route] of [
        ["openship.error", "/reported"],
        ["deployment.failed", "/lifecycle"],
      ]) {
        const matching = logs().filter(
          (log) =>
            attrs(log).event_name === event &&
            (event !== "openship.error" || log.body.stringValue === "Handled downstream failure"),
        );
        expect(matching).toHaveLength(1);
        expect(matching[0].severityText).toBe("ERROR");
        const root = roots.find((span) => attrs(span).http_route === route);
        expect(matching[0].spanId).toBe(root.spanId);
        expect(matching[0].traceId).toBe(root.traceId);
      }
      const errors = logs().filter((log) => attrs(log).event_name === "openship.error");
      expect(errors).toHaveLength(status >= 400 ? 3 : 1);
      expect(new Set(errors.map((log) => attrs(log).observation_id)).size).toBe(
        errors.length,
      );
    },
  );

  it("keeps failed child operations separate from concurrent successful HTTP responses", async () => {
    const app = new Hono();
    app.use("*", observeRequestErrors);
    app.get("/recover/:id", async (context) => {
      await withDiagnosticSpan({ operation: "recoverable.operation" }, async () => {
        await Promise.resolve();
        if (context.req.param("id") === "reported")
          reportError(new Error("Child operation failed"), { handled: true });
        else emitDiagnosticEvent("deployment.failed", { deploymentId: "deploy-child" });
      });
      return context.json({ recovered: true });
    });
    const responses = await Promise.all([
      app.request("/recover/reported"),
      app.request("/recover/lifecycle"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await errorReporter.flush();
    await telemetry.flush();

    const roots = spans().filter((span) => span.name !== "recoverable.operation");
    const children = spans().filter((span) => span.name === "recoverable.operation");
    expect(roots).toHaveLength(2);
    expect(children).toHaveLength(2);
    for (const root of roots) {
      expect(root.status?.code ?? 0).toBe(0);
      const child = children.find((span) => span.parentSpanId === root.spanId);
      expect(child.status.code).toBe(2);
      expect(child.traceId).toBe(root.traceId);
      expect(logs().filter((log) => log.spanId === child.spanId)).toHaveLength(1);
    }
    expect(new Set(roots.map((span) => span.traceId)).size).toBe(2);
  });

  it("uses span completion only for status and leaves error capture to the existing reporter", async () => {
    const failure = new Error("unreported operation failure");
    const cancelled = new DOMException("cancelled", "AbortError");
    for (const error of [failure, cancelled])
      await expect(
        withDiagnosticSpan({ operation: error.name }, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    await telemetry.flush();
    expect(spans().find((span) => span.name === "Error").status.code).toBe(2);
    expect(spans().find((span) => span.name === "AbortError").status?.code ?? 0).toBe(0);
    expect(spans().flatMap((span) => span.events ?? [])).toEqual([]);
    expect(logs()).toEqual([]);
  });

  it("keeps streamed operations open until completion and retains the original thrown error", async () => {
    const failure = new Error("stream failed");
    const operations = observePlatformOperations("jobs", {
      async follow() {
        return {
          data: (async function* () {
            yield 1;
            throw failure;
          })(),
        };
      },
    });
    const output = await operations.follow();
    await telemetry.flush();
    expect(spans()).toHaveLength(0);
    const iterator = output.data[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    await expect(iterator.next()).rejects.toBe(failure);
    await errorReporter.flush();
    await telemetry.flush();
    expect(spans()).toHaveLength(1);
    expect(spans()[0]).toMatchObject({ name: "jobs.follow", status: { code: 2 } });
    expect(logs()[0].spanId).toBe(spans()[0].spanId);
  });

  it("closes and correlates a stream whose iterator factory throws after the request returns", async () => {
    const failure = new Error("iterator unavailable");
    const operations = observePlatformOperations("jobs", {
      async follow() {
        return {
          data: {
            [Symbol.asyncIterator](): AsyncIterator<number> {
              expect(currentErrorContext().operation).toBe("jobs.follow");
              throw failure;
            },
          },
        };
      },
    });
    const output = await operations.follow();
    expect(() => output.data[Symbol.asyncIterator]()).toThrow(failure);
    await errorReporter.flush();
    await telemetry.flush();
    expect(spans()).toHaveLength(1);
    expect(spans()[0]).toMatchObject({ name: "jobs.follow", status: { code: 2 } });
    expect(logs()[0].spanId).toBe(spans()[0].spanId);
    expect(currentErrorContext()).toEqual({});
  });

  it("starts background work with fresh tenant context and records a returned deployment failure as an error", async () => {
    await withDiagnosticSpan(
      { kind: "http", requestId: "request-a", organizationId: "org-a" },
      async () => {
        await observeBackground({ component: "scheduled-job", jobId: "maintenance" }, async () => {
          expect(currentErrorContext().organizationId).toBeUndefined();
          reportError("backup command exited 1", { severity: "error", category: "deployment" });
        });
      },
    );
    await errorReporter.flush();
    await telemetry.flush();
    const job = spans().find((span) => span.name === "scheduled-job")!;
    const request = spans().find((span) => span !== job)!;
    expect(job.traceId).not.toBe(request.traceId);
    expect(job.status.code).toBe(2);
    expect(attrs(job).workspace_id).toBeUndefined();
    expect(logs().find((log) => attrs(log).event_name === "openship.error").spanId).toBe(
      job.spanId,
    );
  });

  it("retains error logs even when root traces are sampled out", async () => {
    await telemetry.close();
    telemetry = createBytesMapTelemetry({ ...config, endpoint, sampleRate: 0 }, "fixture", {
      allowPlaintextLoopback: true,
    });
    telemetry.install();
    await withDiagnosticSpan(
      { operation: "deployments.fail", organizationId: "org-a" },
      async () => {
        reportError(new Error("sampled trace failure"));
      },
    );
    await errorReporter.flush();
    await telemetry.flush();
    expect(spans()).toHaveLength(0);
    expect(logs()).toHaveLength(1);
    expect(logs()[0].traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(logs()[0].spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("does not block or replace application results when the collector refuses traffic", async () => {
    unavailable = true;
    const started = performance.now();
    const value = await withDiagnosticSpan({ operation: "projects.create" }, async () => {
      await audit.record({ organizationId: "org-a" }, { eventType: "project.created" });
      return "created";
    });
    expect(value).toBe("created");
    expect(performance.now() - started).toBeLessThan(250);
    await telemetry.flush(2500).catch(() => {});
    expect(telemetry.status().exportFailures).toBeGreaterThan(0);
  });

  it("observes sanitized errors once despite delivery failure, boundary deduplication and disabled capture", async () => {
    const reporter = new ErrorReporter({
      sink: () => {
        throw new Error("database offline");
      },
      fallback: () => {},
    });
    let observed = 0;
    reporter.setObserver((event) => {
      observed++;
      telemetry.observeError(event);
    });
    const error = new Error("password=private-observer-value");
    reporter.capture(error, { requestId: "request-a", kind: "http" });
    reporter.capture(error, { requestId: "request-a", kind: "http" });
    await reporter.flush();
    reporter.setEnabled(false);
    reporter.capture(error);
    await telemetry.flush();
    expect(observed).toBe(1);
    expect(logs()).toHaveLength(1);
    expect(JSON.stringify(logs())).not.toContain("private-observer-value");
  });
});
