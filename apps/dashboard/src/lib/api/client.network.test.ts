// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("../error-reporting", () => ({ reportClientError: h.report }));
import {
  api,
  ApiError,
  getApiErrorMessage,
  REQUEST_TIMEOUT_MESSAGE,
  setApiResourceScope,
  setNetworkErrorHandler,
  setNetworkRecoveryHandler,
} from "./client";

const fetchMock = vi.fn<typeof fetch>();
const unavailable = vi.fn(),
  reachable = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  fetchMock.mockReset();
  unavailable.mockReset();
  reachable.mockReset();
  h.report.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setApiResourceScope("network-test");
  setNetworkErrorHandler(unavailable);
  setNetworkRecoveryHandler(reachable);
});
afterEach(() => {
  setNetworkErrorHandler(null);
  setNetworkRecoveryHandler(null);
  setApiResourceScope("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reports a fetch transport failure once and preserves the original mutation error", async () => {
  const error = new TypeError("Failed to fetch");
  fetchMock.mockRejectedValue(error);
  await expect(api.post("projects", { name: "app" })).rejects.toBe(error);
  expect(unavailable).toHaveBeenCalledOnce();
  expect(reachable).not.toHaveBeenCalled();
  expect(h.report).toHaveBeenCalledWith(error, expect.objectContaining({ category: "network" }));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", body: '{"name":"app"}' });
});

it("does not declare the API unavailable when request serialization throws TypeError", async () => {
  const body: { self?: unknown } = {};
  body.self = body;
  await expect(api.post("projects", body)).rejects.toBeInstanceOf(TypeError);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(unavailable).not.toHaveBeenCalled();
  expect(h.report.mock.calls[0]![1]).not.toHaveProperty("category", "network");
});

it.each(["json", "text"] as const)(
  "does not reverse HTTP reachability when response.%s throws TypeError",
  async (method) => {
    const error = new TypeError("Response body could not be read");
    const response = method === "json" ? Response.json({}) : new Response("text");
    vi.spyOn(response, method).mockRejectedValue(error);
    fetchMock.mockResolvedValue(response);
    await expect(api.get("projects")).rejects.toBe(error);
    expect(reachable).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
    expect(h.report.mock.calls[0]![1]).not.toHaveProperty("category", "network");
  },
);

it.each([401, 503])(
  "treats HTTP %s as reachability evidence while preserving its API error",
  async (status) => {
    fetchMock.mockResolvedValue(Response.json({ message: "Request failed" }, { status }));
    await expect(api.get("projects")).rejects.toMatchObject({
      status,
      body: { message: "Request failed" },
    });
    expect(reachable).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
  },
);

it("preserves HTTP status when the error response body cannot be read", async () => {
  const response = new Response("", { status: 503 });
  vi.spyOn(response, "text").mockRejectedValue(new TypeError("body stream failed"));
  fetchMock.mockResolvedValue(response);
  await expect(api.get("projects")).rejects.toBeInstanceOf(ApiError);
  expect(reachable).toHaveBeenCalledOnce();
  expect(unavailable).not.toHaveBeenCalled();
});

it("keeps timeout failure local to the request", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
  );
  const request = api.post("slow-operation", {}, { timeout: 100 }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(100);
  const error = await request;
  expect(error).toMatchObject({ name: "AbortError" });
  expect(getApiErrorMessage(error)).toBe(REQUEST_TIMEOUT_MESSAGE);
  expect(unavailable).not.toHaveBeenCalled();
  expect(reachable).not.toHaveBeenCalled();
  expect(h.report).toHaveBeenCalledWith(error, expect.objectContaining({ category: "timeout" }));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not turn a response-body timeout into a global offline signal", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(async (_url, init) => {
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    return response;
  });
  const request = api.get("slow-body", { timeout: 100 }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await request).toMatchObject({ name: "AbortError" });
  expect(reachable).toHaveBeenCalledOnce();
  expect(unavailable).not.toHaveBeenCalled();
});

it("forwards caller cancellation and its original reason without declaring a transport failure", async () => {
  const caller = new AbortController();
  const removed = vi.spyOn(caller.signal, "removeEventListener");
  let forwarded!: AbortSignal;
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        forwarded = init!.signal!;
        forwarded.addEventListener("abort", () => reject(forwarded.reason), { once: true });
      }),
  );
  const request = api.get("projects", { signal: caller.signal }).catch((error) => error);
  const reason = new TypeError("Caller discarded this request");
  caller.abort(reason);
  expect(await request).toBe(reason);
  expect(forwarded.aborted).toBe(true);
  expect(forwarded.reason).toBe(reason);
  expect(unavailable).not.toHaveBeenCalled();
  expect(h.report).not.toHaveBeenCalled();
  expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("does not fetch an already-cancelled request or present it as a timeout", async () => {
  const caller = new AbortController();
  caller.abort();
  const error = await api.get("projects", { signal: caller.signal }).catch((error) => error);
  expect(error).toBe(caller.signal.reason);
  expect(getApiErrorMessage(error)).toBe("Request cancelled.");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(unavailable).not.toHaveBeenCalled();
});

it("does not deduplicate caller-cancellable GETs with independent requests", async () => {
  const caller = new AbortController();
  fetchMock.mockImplementation((_url, init) => {
    if (fetchMock.mock.calls.length === 1)
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    return Promise.resolve(Response.json({ ok: true }));
  });
  const cancelled = api.get("projects", { signal: caller.signal }).catch((error) => error);
  const independent = api.get("projects");
  caller.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect(await independent).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(unavailable).not.toHaveBeenCalled();
});

it("does not overwrite a newer HTTP response with an older transport failure", async () => {
  const old = deferred<Response>(),
    newer = deferred<Response>();
  fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
  const first = api.get("older").catch((error) => error),
    second = api.get("newer");
  newer.resolve(Response.json({ ok: true }));
  await second;
  const failure = new TypeError("Old request failed");
  old.reject(failure);
  expect(await first).toBe(failure);
  expect(reachable).toHaveBeenCalledOnce();
  expect(unavailable).not.toHaveBeenCalled();
});

it("does not let an older response overwrite a newer transport failure", async () => {
  const old = deferred<Response>(),
    newer = deferred<Response>();
  fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
  const first = api.get("older"),
    second = api.get("newer").catch((error) => error);
  newer.reject(new TypeError("New connection failed"));
  await second;
  old.resolve(Response.json({ ok: true }));
  await first;
  expect(unavailable).toHaveBeenCalledOnce();
  expect(reachable).not.toHaveBeenCalled();
});

it("allows a later request to recover after a transport failure", async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  await expect(api.get("projects")).rejects.toThrow("offline");
  await api.get("projects");
  expect(unavailable).toHaveBeenCalledOnce();
  expect(reachable).toHaveBeenCalledOnce();
});

it("ignores network outcomes from requests belonging to the previous resource scope", async () => {
  const old = deferred<Response>();
  fetchMock.mockReturnValueOnce(old.promise);
  const first = api.get("projects").catch((error) => error);
  setApiResourceScope("another-account");
  old.reject(new TypeError("Old account request failed"));
  await first;
  expect(unavailable).not.toHaveBeenCalled();
  expect(reachable).not.toHaveBeenCalled();
});
