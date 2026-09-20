import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { safeFetch } from "@repo/platform/engine/lib/safe-fetch";
import { SsrfError } from "@repo/platform/engine/lib/ssrf-guard";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));
const requests: string[] = [];
let bodyClosed: Promise<unknown> | undefined;
const server = http.createServer((req, res) => {
  requests.push(req.url!);
  if (req.url === "/body") {
    res.writeHead(200);
    res.write("still streaming");
    bodyClosed = once(res, "close");
  } else if (req.url!.startsWith("/redirect/")) {
    const step = Number(req.url!.split("/").at(-1));
    const timer = setTimeout(() => {
      if (step < 3) res.writeHead(302, { location: `/redirect/${step + 1}` });
      res.end("done");
    }, 100);
    res.on("close", () => clearTimeout(timer));
  } else res.end("ok");
});
const listening = new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  lookup.mockReset();
  requests.length = 0;
  bodyClosed = undefined;
});
afterEach(() => vi.useRealTimers());
const opts = { allowHttp: true, allowPrivate: true, timeoutMs: 100 };

describe("safeFetch total deadline (GH-880)", () => {
  it("times out stalled DNS and never connects when that lookup completes late", async () => {
    const port = await listening;
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    lookup.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = expect(
      safeFetch(`http://registry.test:${port}/dns`, opts),
    ).rejects.toBeInstanceOf(SsrfError);
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    release([{ address: "127.0.0.1", family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await (await safeFetch(`http://registry.test:${port}/recovered`, opts)).text()).toBe(
      "ok",
    );
    expect(requests).toEqual(["/recovered"]);
  });

  it("consumes a resolver rejection after the deadline without an unhandled promise", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    lookup.mockReturnValue(
      new Promise((_resolve, r) => {
        reject = r;
      }),
    );
    const pending = expect(safeFetch("https://registry.test", opts)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    reject(new Error("late resolver failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys a response whose body never finishes", async () => {
    await expect(safeFetch(`http://127.0.0.1:${await listening}/body`, opts)).rejects.toThrow(
      /timed out/,
    );
    expect(requests).toEqual(["/body"]);
    await bodyClosed;
  });

  it("shares the deadline across redirects while still validating every destination", async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${await listening}/redirect/0`, {
        ...opts,
        timeoutMs: 250,
        maxRedirects: 4,
      }),
    ).rejects.toThrow(/timed out/);
    expect(requests).toContain("/redirect/0");
    expect(requests).not.toContain("/redirect/3");
  });
});
