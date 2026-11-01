import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  consoleErrorSink,
  errorReporter,
  type ErrorEvent,
} from "@repo/core/diagnostics";
import { pushInstanceSettings, waitForApi } from "@repo/onboarding";

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
  errorReporter.setSink(consoleErrorSink);
});

it("records a rejected setup without exposing the settings or internal token", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(null, {
      status: 403,
      headers: { "X-Request-ID": "setup-request-1" },
    }),
  );
  expect(
    await pushInstanceSettings(
      {
        apiUrl: "http://setup.invalid",
        internalToken: "internal-private-913",
        fetch,
      },
      {
        tunnel: { provider: "cloudflare", token: "tunnel-private-913" },
      },
    ),
  ).toBe(false);
  await errorReporter.flush();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    category: "authorization",
    context: { operation: "system.setup", requestId: "setup-request-1" },
  });
  expect(JSON.stringify(events)).not.toMatch(/internal-private|tunnel-private/);
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps successful startup polling quiet and reports a terminal readiness failure once", async () => {
  const failure = Object.assign(new Error("Connection refused"), {
    code: "ECONNREFUSED",
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(new Response());
  expect(
    await waitForApi({ apiUrl: "http://setup.invalid", fetch }, 2, 0),
  ).toBe(true);
  await errorReporter.flush();
  expect(events).toHaveLength(0);

  fetch.mockReset().mockRejectedValue(failure);
  expect(
    await waitForApi({ apiUrl: "http://setup.invalid", fetch }, 2, 0),
  ).toBe(false);
  await errorReporter.flush();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    category: "timeout",
    error: { code: "ECONNREFUSED" },
    context: { attempt: 2 },
  });
});
