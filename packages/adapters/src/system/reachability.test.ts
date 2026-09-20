import { describe, expect, test, vi } from "vitest";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { probeTcp, probeTcpDetailed, probeHttp, waitForReady } from "./reachability";

const tcpMock = vi.hoisted(() => ({
  simulateTimeout: false,
  /** Emit `error` with this errno instead of dialing. Drives the classification
   *  table without depending on the box's DNS or routing. */
  errorCode: null as string | null,
  setTimeout: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();

  return {
    ...actual,
    connect: (...args: unknown[]) => {
      if (!tcpMock.simulateTimeout && !tcpMock.errorCode) {
        return (actual.connect as (...params: unknown[]) => ReturnType<typeof actual.connect>)(...args);
      }

      const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
      const emit = (event: string, ...a: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...a);
      };
      const socket = {
        setTimeout: (timeoutMs: number) => {
          tcpMock.setTimeout(timeoutMs);
          queueMicrotask(() => {
            if (tcpMock.simulateTimeout) return emit("timeout");
            const err: NodeJS.ErrnoException = new Error(`simulated ${tcpMock.errorCode}`);
            err.code = tcpMock.errorCode ?? undefined;
            emit("error", err);
          });
          return socket;
        },
        once: (event: string, listener: (...a: unknown[]) => void) => {
          const eventListeners = listeners.get(event) ?? [];
          eventListeners.push(listener);
          listeners.set(event, eventListeners);
          return socket;
        },
        destroy: () => tcpMock.destroy(),
      };

      return socket as unknown as ReturnType<typeof actual.connect>;
    },
  };
});

/** Run `fn` with the socket mock emitting `error` carrying `code`. */
async function withDialError<T>(code: string, fn: () => Promise<T>): Promise<T> {
  tcpMock.errorCode = code;
  try {
    return await fn();
  } finally {
    tcpMock.errorCode = null;
  }
}

/** Bind a throwaway TCP server on an ephemeral port and return {port, close}. */
async function listenEphemeral(): Promise<{ port: number; close: () => void }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  return { port: address.port, close: () => server.close() };
}

/** Bind a throwaway HTTP server that always answers `status`. */
async function listenHttp(status: number): Promise<{ port: number; close: () => void }> {
  const server: HttpServer = createHttpServer((_req, res) => {
    res.statusCode = status;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  return { port: address.port, close: () => server.close() };
}

/** A free port (bound then released), for negative cases. */
async function freePort(): Promise<number> {
  const { port, close } = await listenEphemeral();
  close();
  await new Promise((r) => setTimeout(r, 50));
  return port;
}

describe("probeTcp", () => {
  test("resolves true when the port is accepting connections", async () => {
    const { port, close } = await listenEphemeral();
    try {
      expect(await probeTcp("127.0.0.1", port, 1000)).toBe(true);
    } finally {
      close();
    }
  });

  test("resolves false when nothing is listening (connection refused)", async () => {
    // Bind then immediately close to get a port that's free right now.
    const { port, close } = await listenEphemeral();
    close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await probeTcp("127.0.0.1", port, 1000)).toBe(false);
  });

  test("resolves false when the connection times out", async () => {
    tcpMock.simulateTimeout = true;
    tcpMock.setTimeout.mockClear();
    tcpMock.destroy.mockClear();
    try {
      expect(await probeTcp("example.test", 22, 600)).toBe(false);
      expect(tcpMock.setTimeout).toHaveBeenCalledWith(600);
      expect(tcpMock.destroy).toHaveBeenCalledOnce();
    } finally {
      tcpMock.simulateTimeout = false;
    }
  });
});

/**
 * A dropped packet and a refused one demand different fixes, and the host-channel
 * diagnosis reads this to decide whether a firewall rule is even relevant (#490).
 * Flattening them back into a boolean is the regression to catch here.
 */
describe("probeTcpDetailed", () => {
  test("ok, with nothing else to explain, when the port accepts", async () => {
    const { port, close } = await listenEphemeral();
    try {
      expect(await probeTcpDetailed("127.0.0.1", port, 1000)).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test("a real refusal reports `refused`, not `timeout`", async () => {
    // Unmocked: this is the one failure a loopback dial produces for real, so it
    // pins the classification against the actual kernel errno, not our mock's.
    expect(await probeTcpDetailed("127.0.0.1", await freePort(), 1000)).toMatchObject({
      ok: false,
      reason: "refused",
      code: "ECONNREFUSED",
    });
  });

  test("silence to the deadline reports `timeout` — the dropped-packet shape", async () => {
    tcpMock.simulateTimeout = true;
    try {
      expect(await probeTcpDetailed("example.test", 22, 600)).toMatchObject({
        ok: false,
        reason: "timeout",
      });
    } finally {
      tcpMock.simulateTimeout = false;
    }
  });

  test("a name that didn't resolve is its own cause, never a firewall", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      expect(await withDialError(code, () => probeTcpDetailed("nope.invalid", 22, 600))).toMatchObject(
        { ok: false, reason: "unresolved", code },
      );
    }
  });

  test("no route home is distinguished from a filtered one", async () => {
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"]) {
      expect(await withDialError(code, () => probeTcpDetailed("10.0.0.1", 22, 600))).toMatchObject({
        ok: false,
        reason: "no_route",
        code,
      });
    }
  });

  test("a kernel-side connect timeout counts as `timeout`, not a stray error", async () => {
    expect(await withDialError("ETIMEDOUT", () => probeTcpDetailed("10.0.0.1", 22, 600))).toMatchObject(
      { ok: false, reason: "timeout", code: "ETIMEDOUT" },
    );
  });

  test("an unrecognized errno falls back to `error` and carries it verbatim", async () => {
    // `error` must stay the catch-all: guessing a cause here would put a firewall
    // rule in front of an operator whose problem is something else entirely.
    expect(await withDialError("EPERM", () => probeTcpDetailed("10.0.0.1", 22, 600))).toMatchObject({
      ok: false,
      reason: "error",
      code: "EPERM",
      message: "simulated EPERM",
    });
  });

  test("probeTcp stays a boolean view of the same probe", async () => {
    expect(await withDialError("ECONNREFUSED", () => probeTcp("10.0.0.1", 22, 600))).toBe(false);
  });
});

describe("probeHttp", () => {
  test("true for a 2xx response", async () => {
    const { port, close } = await listenHttp(200);
    try {
      expect(await probeHttp("127.0.0.1", port, "/", 1000)).toBe(true);
    } finally {
      close();
    }
  });

  test("true for a 4xx (server is serving, path just missing)", async () => {
    const { port, close } = await listenHttp(404);
    try {
      expect(await probeHttp("127.0.0.1", port, "/", 1000)).toBe(true);
    } finally {
      close();
    }
  });

  test("false for a 5xx", async () => {
    const { port, close } = await listenHttp(503);
    try {
      expect(await probeHttp("127.0.0.1", port, "/", 1000)).toBe(false);
    } finally {
      close();
    }
  });

  test("false (never throws) when nothing is listening", async () => {
    expect(await probeHttp("127.0.0.1", await freePort(), "/", 1000)).toBe(false);
  });
});

describe("waitForReady", () => {
  test("returns true once a port that starts late begins accepting connections", async () => {
    const { port, close } = await listenEphemeral();
    close(); // not listening yet
    // Bring it up after ~300ms; waitForReady should poll until it connects.
    const late = setTimeout(() => {
      createServer().listen(port, "127.0.0.1");
    }, 300);
    try {
      const ready = await waitForReady("127.0.0.1", port, { timeoutMs: 3000, intervalMs: 100 });
      expect(ready).toBe(true);
    } finally {
      clearTimeout(late);
    }
  });

  test("returns false when the port never comes up before the deadline", async () => {
    const start = Date.now();
    const ready = await waitForReady("127.0.0.1", await freePort(), {
      timeoutMs: 600,
      intervalMs: 100,
      probeTimeoutMs: 200,
    });
    expect(ready).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("with a path, requires an HTTP status below 500", async () => {
    const bad = await listenHttp(500);
    try {
      const ready = await waitForReady("127.0.0.1", bad.port, {
        path: "/",
        timeoutMs: 500,
        intervalMs: 100,
      });
      expect(ready).toBe(false); // TCP connects, but 500 keeps it not-ready
    } finally {
      bad.close();
    }

    const good = await listenHttp(200);
    try {
      expect(await waitForReady("127.0.0.1", good.port, { path: "/", timeoutMs: 2000 })).toBe(true);
    } finally {
      good.close();
    }
  });
});
