import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "@repo/platform/engine/lib/safe-fetch";
import { SsrfError } from "@repo/platform/engine/lib/ssrf-guard";

// A local echo server so the happy path exercises the real node:http transport.
const server = http.createServer((req, res) => {
  if (req.url === "/redirect") {
    res.statusCode = 302;
    res.setHeader("location", redirectTarget);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        method: req.method,
        host: req.headers.host,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        marker: req.headers["x-marker"],
        body,
      }),
    );
  });
});
const listening = new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});

let redirectTarget = "";
const redirectReceiver = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      marker: req.headers["x-marker"],
    }),
  );
});
const redirectReceiverListening = new Promise<number>((resolve) => {
  redirectReceiver.listen(0, "127.0.0.1", () =>
    resolve((redirectReceiver.address() as AddressInfo).port),
  );
});

afterAll(() => {
  server.close();
  redirectReceiver.close();
});

describe("safeFetch — SSRF pinning", () => {
  it("rejects a loopback IPv4 literal when private isn't allowed", async () => {
    await expect(safeFetch("http://127.0.0.1/", { allowHttp: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a hex-form v4-mapped IPv6 loopback (the guard-bypass vector)", async () => {
    await expect(safeFetch("http://[::ffff:7f00:1]/", { allowHttp: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects blocked internal hostnames", async () => {
    await expect(safeFetch("http://localhost/", { allowHttp: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects plaintext http unless allowHttp is set", async () => {
    await expect(safeFetch("http://example.com/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("reaches an allowed target and preserves method + Host", async () => {
    const port = await listening;
    const res = await safeFetch(`http://127.0.0.1:${port}/x`, {
      method: "POST",
      body: "hi",
      allowHttp: true,
      allowPrivate: true,
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { method: string; host: string; body: string };
    expect(json.method).toBe("POST");
    expect(json.host).toBe(`127.0.0.1:${port}`);
    expect(json.body).toBe("hi");
  });

  it("strips credentials before following a cross-origin redirect", async () => {
    const [sourcePort, destinationPort] = await Promise.all([listening, redirectReceiverListening]);
    redirectTarget = `http://127.0.0.1:${destinationPort}/capture`;

    const res = await safeFetch(`http://127.0.0.1:${sourcePort}/redirect`, {
      headers: {
        authorization: "Basic c2VjcmV0",
        cookie: "session=secret",
        "x-marker": "preserved",
      },
      allowHttp: true,
      allowPrivate: true,
      maxRedirects: 1,
    });
    const json = (await res.json()) as {
      authorization?: string;
      cookie?: string;
      marker?: string;
    };

    expect(json.authorization).toBeUndefined();
    expect(json.cookie).toBeUndefined();
    expect(json.marker).toBe("preserved");
  });
});
