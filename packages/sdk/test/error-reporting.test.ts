import { beforeEach, expect, it } from "vitest";
import { errorReporter, type ErrorEvent } from "@repo/core/diagnostics";
import { responseError } from "../src/errors";
import { HttpClient } from "../src/http";

const events: ErrorEvent[] = [];
beforeEach(async () => {
  await errorReporter.flush();
  events.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink((batch) => {
    events.push(...batch);
  });
});

it("observes a rejected fetch without retrying it or inspecting the credential provider", async () => {
  const failure = Object.assign(new Error("Connection refused"), {
    code: "ECONNREFUSED",
  });
  let calls = 0;
  const transport = new HttpClient({
    baseUrl: "https://instance.example/api",
    token: "private-sdk-913",
    fetch: async () => {
      calls++;
      throw failure;
    },
  });
  await expect(transport.raw("/projects")).rejects.toBe(failure);
  await errorReporter.flush();
  expect(calls).toBe(1);
  expect(events[0]).toMatchObject({
    category: "network",
    context: { source: "sdk", component: "sdk-http" },
  });
  expect(JSON.stringify(events)).not.toContain("private-sdk-913");
});

it("retains the API request reference without sending the response body to diagnostics", async () => {
  const requestId = "6d32554b-afce-4239-bd98-5df3056eb8bb";
  const body = {
    code: "FORBIDDEN",
    error: "Access denied",
    details: { token: "private-sdk-913" },
  };
  const error = await responseError(
    Response.json(body, {
      status: 403,
      headers: { "X-Request-ID": requestId },
    }),
  );
  expect(error.requestId).toBe(requestId);
  expect(error.body).toEqual(body);
  await errorReporter.flush();
  expect(events[0]).toMatchObject({
    category: "authorization",
    context: { source: "sdk", requestId, statusCode: 403 },
  });
  expect(JSON.stringify(events)).not.toContain("private-sdk-913");
});
