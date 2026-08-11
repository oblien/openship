import { describe, expect, it } from "vitest";
import { Duplex } from "node:stream";
import { waitForForwardedReady } from "../../../src/modules/deployments/forwarded-readiness";

function response(status: number): Duplex {
  let sent = false;
  return new Duplex({
    read() {
      if (sent) return;
      sent = true;
      this.push(`HTTP/1.1 ${status} Test\r\nContent-Length: 0\r\n\r\n`);
      this.push(null);
    },
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("waitForForwardedReady", () => {
  it("accepts a forwarded TCP connection", async () => {
    const calls: Array<[string, number]> = [];
    const ready = await waitForForwardedReady(
      async (host, port) => {
        calls.push([host, port]);
        return response(200);
      },
      "127.0.0.1",
      20_001,
      { timeoutMs: 20, probeTimeoutMs: 10 },
    );

    expect(ready).toBe(true);
    expect(calls).toEqual([["127.0.0.1", 20_001]]);
  });

  it("requires a forwarded HTTP response below 500", async () => {
    let attempts = 0;
    const ready = await waitForForwardedReady(
      async () => response(++attempts === 1 ? 503 : 204),
      "127.0.0.1",
      20_001,
      { path: "/healthz", timeoutMs: 100, intervalMs: 1, probeTimeoutMs: 20 },
    );

    expect(ready).toBe(true);
    expect(attempts).toBe(2);
  });

  it("times out when the forwarded target keeps refusing", async () => {
    let attempts = 0;
    const ready = await waitForForwardedReady(
      async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      },
      "127.0.0.1",
      20_001,
      { timeoutMs: 20, intervalMs: 1, probeTimeoutMs: 5 },
    );

    expect(ready).toBe(false);
    expect(attempts).toBeGreaterThan(1);
  });

  it("rejects a path that could inject an HTTP header", async () => {
    const ready = await waitForForwardedReady(async () => response(200), "127.0.0.1", 20_001, {
      path: "/healthz\r\nX-Bad: yes",
      timeoutMs: 5,
      intervalMs: 1,
    });

    expect(ready).toBe(false);
  });
});
