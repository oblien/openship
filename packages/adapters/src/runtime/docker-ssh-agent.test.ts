import net from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createDockerSshBridge } from "./docker-ssh-agent";
import type { DockerConnectionOptions } from "./docker-transport";

/**
 * Regression guard for the reported API crash: navigating project tabs fires
 * Docker-backed calls, and when the bridge could open NO upstream (streamlocal
 * refused → dial-stdio SSH auth fails) `captureClient.fail()` used to
 * `client.destroy(err)` after detaching the socket's only 'error' listener — an
 * unhandled 'error' event that killed the whole Node API process for every
 * project, not just the one dead request. A configured `dockerSocketPath` skips
 * remote discovery and a failing `executor` drives both upstreams to reject
 * with no real ssh2, so the crash path runs deterministically.
 */
describe("createDockerSshBridge — an upstream failure never crashes the process", () => {
  const bridges: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const b of bridges.splice(0)) b.close();
  });

  function failingBridge(overrides?: Partial<DockerConnectionOptions>) {
    const bridge = createDockerSshBridge({
      host: "test-host",
      username: "root",
      // Skip remote socket discovery so the executor mock needs no `exec`.
      dockerSocketPath: "/var/run/docker.sock",
      executor: {
        // streamlocal probe rejects → mode resolves to dial-stdio…
        forwardUnixSocket: (): Promise<Duplex> =>
          Promise.reject(new Error("streamlocal forwarding refused")),
        // …then the dial-stdio open rejects → bridgeClient catch → capture.fail().
        openDockerDialStdio: (): Promise<Duplex> =>
          Promise.reject(new Error("SSH key authentication failed for root@test-host")),
      },
      ...overrides,
    } as unknown as DockerConnectionOptions);
    bridges.push(bridge);
    return bridge;
  }

  it("closes the one dead Docker request with no unhandled 'error' event", async () => {
    // A user listener is what stands between the old buggy behavior and a killed
    // worker: with it present Node routes the (old) unhandled 'error' here instead
    // of aborting, so we can ASSERT it never fired rather than just crashing.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      const bridge = failingBridge();
      const { host, port } = await bridge.start();

      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000);
        const sock = net.connect(port, host, () => {
          sock.write("GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n");
        });
        // A mid-request reset is the EXPECTED outcome — not a crash.
        sock.on("error", () => {});
        sock.on("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      expect(closed).toBe(true);
      // Let any queued 'error' emission surface before asserting none did.
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  });

  it("survives a second failing request on the same bridge", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      const bridge = failingBridge();
      const { host, port } = await bridge.start();

      for (let i = 0; i < 2; i++) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          const sock = net.connect(port, host, () => {
            sock.write("GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n");
          });
          sock.on("error", () => {});
          sock.on("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  });
});
