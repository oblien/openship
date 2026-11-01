import { afterEach, expect, it, vi } from "vitest";
import { Oblien } from "./oblien";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("renews expiring execution credentials once before concurrent requests, without replaying mutations", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response('{"success":true}', { headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  const refresh = vi.fn(async () => ({
    token: "renewed",
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  }));
  const client = new Oblien({
    token: "initial",
    tokenRefresh: { expiresAt: new Date(Date.now() + 120000).toISOString(), refresh },
  });
  await client._http.request({ method: "GET", path: "/first" });
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("Authorization")).toBe(
    "Bearer initial",
  );
  await vi.advanceTimersByTimeAsync(61000);
  await Promise.all([
    client._http.request({ method: "GET", path: "/read" }),
    client._http.request({ method: "POST", path: "/write", body: { once: true } }),
  ]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const call of fetcher.mock.calls.slice(1))
    expect(new Headers(call[1]?.headers).get("Authorization")).toBe("Bearer renewed");
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
});

it("does not dispatch a mutation when credential renewal fails", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const client = new Oblien({
    token: "expired",
    tokenRefresh: {
      expiresAt: new Date(0).toISOString(),
      refresh: async () => {
        throw new Error("ownership could not be verified");
      },
    },
  });
  await expect(client._http.request({ method: "POST", path: "/write" })).rejects.toThrow(
    "ownership could not be verified",
  );
  expect(fetcher).not.toHaveBeenCalled();
});
