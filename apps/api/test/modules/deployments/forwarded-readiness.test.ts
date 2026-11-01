import { afterEach, describe, expect, it, vi } from "vitest";
import { Duplex } from "node:stream";
import { createServer } from "node:http";
import {
  buildHostProbeCommand,
  isForwardingProhibited,
  parseHostProbeOutput,
  waitForForwardedReady,
  waitForReadyFromExecutor,
} from "@repo/platform/engine/modules/deployments/forwarded-readiness";
import { LocalExecutor, type CommandExecutor } from "@repo/adapters";

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

function silentStream(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function connectionRefused(): Error & { reason: number } {
  return Object.assign(new Error("(SSH) Channel open failure: Connection refused"), { reason: 2 });
}

afterEach(() => vi.useRealTimers());

/** ssh2's shape for a channel the server refused: numeric `reason` + sshd's description. */
function prohibited(): Error & { reason: number } {
  const err = new Error(
    "(SSH) Channel open failure: administratively prohibited: open failed",
  ) as Error & { reason: number };
  err.reason = 1;
  return err;
}

describe("waitForForwardedReady", () => {
  it("accepts a forwarded TCP connection", async () => {
    const calls: Array<[string, number]> = [];
    const result = await waitForForwardedReady(
      async (host, port) => {
        calls.push([host, port]);
        return response(200);
      },
      "127.0.0.1",
      20_001,
      { timeoutMs: 20, probeTimeoutMs: 10 },
    );

    expect(result.ready).toBe(true);
    expect(calls).toEqual([["127.0.0.1", 20_001]]);
  });

  it("requires a forwarded HTTP response below 500", async () => {
    let attempts = 0;
    const result = await waitForForwardedReady(
      async () => response(++attempts === 1 ? 503 : 204),
      "127.0.0.1",
      20_001,
      { path: "/healthz", timeoutMs: 100, intervalMs: 1, probeTimeoutMs: 20 },
    );

    expect(result.ready).toBe(true);
    expect(attempts).toBe(2);
  });

  it("times out when the forwarded target keeps refusing", async () => {
    let attempts = 0;
    const result = await waitForForwardedReady(
      async () => {
        attempts += 1;
        throw connectionRefused();
      },
      "127.0.0.1",
      20_001,
      { timeoutMs: 20, intervalMs: 1, probeTimeoutMs: 5 },
    );

    expect(result.ready).toBe(false);
    // A connect failure is the state a readiness probe polls THROUGH, so it keeps trying.
    expect(result.prohibited).toBeUndefined();
    expect(attempts).toBeGreaterThan(1);
  });

  it("retries a closed app port and passes when the app starts listening", async () => {
    const forward = vi
      .fn()
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce(response(200));

    const result = await waitForForwardedReady(forward, "127.0.0.1", 20_001, {
      path: "/ready",
      timeoutMs: 100,
      intervalMs: 1,
      probeTimeoutMs: 20,
    });

    expect(result).toEqual({ ready: true });
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it("rejects a path that could inject an HTTP header", async () => {
    const result = await waitForForwardedReady(async () => response(200), "127.0.0.1", 20_001, {
      path: "/healthz\r\nX-Bad: yes",
      timeoutMs: 5,
      intervalMs: 1,
    });

    expect(result.ready).toBe(false);
  });

  // GH-583. sshd refusing the channel is NOT the app being down, and it must not be
  // polled for the full timeout before saying so.
  it("stops immediately and reports when the server PROHIBITS forwarding", async () => {
    let attempts = 0;
    const result = await waitForForwardedReady(
      async () => {
        attempts += 1;
        throw prohibited();
      },
      "127.0.0.1",
      20_001,
      { timeoutMs: 5_000, intervalMs: 1, probeTimeoutMs: 50 },
    );

    expect(result.ready).toBe(false);
    expect(result.prohibited).toContain("administratively prohibited");
    expect(attempts).toBe(1);
  });
});

describe("isForwardingProhibited", () => {
  it("recognizes ADMINISTRATIVELY_PROHIBITED by reason code and by description", () => {
    expect(isForwardingProhibited(prohibited())).toBe(true);
    expect(isForwardingProhibited({ reason: 1 })).toBe(true);
    expect(isForwardingProhibited(new Error("administratively prohibited: open failed"))).toBe(
      true,
    );
  });

  it("recognizes a server that does not do direct-tcpip at all", () => {
    expect(isForwardingProhibited({ reason: 3 })).toBe(true);
  });

  // The distinction the whole fix rests on: reason 2 is "the host tried and nothing was
  // listening" — precisely what a readiness probe expects to see while an app boots.
  it("does NOT treat a connect failure as a refusal", () => {
    expect(isForwardingProhibited({ reason: 2 })).toBe(false);
    expect(isForwardingProhibited(new Error("connect failed"))).toBe(false);
    expect(isForwardingProhibited(new Error("ECONNREFUSED"))).toBe(false);
    expect(isForwardingProhibited(undefined)).toBe(false);
    expect(isForwardingProhibited("nope")).toBe(false);
  });
});

describe("buildHostProbeCommand", () => {
  it("quotes the URL, always exits 0, and asks for the connect COUNT", () => {
    const cmd = buildHostProbeCommand({
      host: "127.0.0.1",
      port: 20_000,
      path: "/ready",
      timeoutSeconds: 3,
    });
    expect(cmd).toContain("'http://127.0.0.1:20000/ready'");
    expect(cmd).toContain("--max-time '3'");
    // Exits 0 so curl's own non-zero outcomes (52 "empty reply" et al) can be read from
    // stdout instead of being collapsed into a thrown error by `executor.exec`.
    expect(cmd).toContain("exit 0");
    // `num_connects`, not the exit code, is what makes the TCP verdict exact.
    expect(cmd).toContain("%{num_connects}");
  });

  it("probes the root path when readiness declares none", () => {
    const cmd = buildHostProbeCommand({ host: "10.0.0.4", port: 8080, timeoutSeconds: 1 });
    expect(cmd).toContain("'http://10.0.0.4:8080/'");
  });

  // The command is built from a project-supplied path and run on the host as root, so the
  // quote that would end the URL word has to be neutralized rather than merely absent.
  it("cannot be broken out of by a hostile path", () => {
    const cmd = buildHostProbeCommand({
      host: "127.0.0.1",
      port: 20_000,
      path: "/x'; touch /tmp/pwned; echo '",
      timeoutSeconds: 1,
    });
    // The payload survives as LITERAL text (it is inside the quoted URL) — what must not
    // appear is an unescaped quote closing the word right before it.
    expect(cmd).not.toContain("/x'; touch");
    expect(cmd).toContain(String.raw`/x'\''; touch`);
  });
});

describe("parseHostProbeOutput", () => {
  it("reads the status and the connect count back", () => {
    expect(parseHostProbeOutput("OPENSHIP_PROBE 204 1\n")).toEqual({
      kind: "result",
      status: 204,
      connects: 1,
    });
  });

  // curl still writes `-w` when the transfer failed, so "no HTTP response, no connection"
  // arrives as a readable result rather than as unparsed output.
  it("reads a total failure as status 0 with no connects", () => {
    expect(parseHostProbeOutput("OPENSHIP_PROBE 000 0\n")).toEqual({
      kind: "result",
      status: 0,
      connects: 0,
    });
  });

  it("detects a host with no HTTP client", () => {
    expect(parseHostProbeOutput("OPENSHIP_PROBE_NO_CLIENT\n")).toEqual({ kind: "no-client" });
  });

  it("reports unreadable output rather than guessing", () => {
    expect(parseHostProbeOutput("")).toEqual({ kind: "unparsed" });
    expect(parseHostProbeOutput("bash: curl: command not found")).toEqual({ kind: "unparsed" });
  });
});

/** Minimal executor: only the two methods the probe reaches for. */
function executorWith(opts: {
  forward?: () => Promise<Duplex>;
  exec?: (command: string) => Promise<string>;
  onDisconnect?: CommandExecutor["onDisconnect"];
}): CommandExecutor {
  return {
    ...(opts.forward ? { forwardPort: opts.forward } : {}),
    exec: opts.exec ?? (async () => ""),
    onDisconnect: opts.onDisconnect,
  } as unknown as CommandExecutor;
}

describe("waitForReadyFromExecutor", () => {
  it("probes a managed server through its executor when TCP forwarding is unavailable", async () => {
    const exec = vi.fn(async () => "OPENSHIP_PROBE 204 1");
    const result = await waitForReadyFromExecutor(
      executorWith({ exec }), "127.0.0.1", 20_000,
      { path: "/ready", timeoutMs: 50 },
    );

    expect(result).toEqual({ ready: true, via: "exec" });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("'http://127.0.0.1:20000/ready'"),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("cannot accept a healthy controller port as proof that a remote app is ready", async () => {
    const server = createServer((_request, response) => { response.end("controller"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const exec = vi.fn(async () => "OPENSHIP_PROBE 503 1");
      const result = await waitForReadyFromExecutor(
        executorWith({ exec }), "127.0.0.1", port,
        { path: "/ready", timeoutMs: 20, intervalMs: 1 },
      );
      expect(result).toEqual({ ready: false, via: "exec" });
      expect(exec).toHaveBeenCalled();

      // The same address belongs to this machine only for an explicit local executor.
      expect(await waitForReadyFromExecutor(new LocalExecutor(), "127.0.0.1", port, {
        path: "/ready", timeoutMs: 500,
      })).toEqual({ ready: true, via: "socket" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    ["missing HTTP client", async () => "OPENSHIP_PROBE_NO_CLIENT", "no `curl`"],
    ["lost provider connection", async () => { throw new Error("provider unavailable"); }, "provider unavailable"],
  ] as const)("reports a managed server's %s as unverified", async (_label, exec, detail) => {
    const result = await waitForReadyFromExecutor(
      executorWith({ exec }), "127.0.0.1", 20_000,
      { path: "/ready", timeoutMs: 50 },
    );
    expect(result).toEqual({ ready: false, via: "exec", unverifiable: expect.stringContaining(detail) });
  });

  it("uses the forwarded channel when the server allows it", async () => {
    const exec = vi.fn();
    const unsubscribe = vi.fn();
    const onDisconnect = vi.fn(() => unsubscribe);
    const result = await waitForReadyFromExecutor(
      executorWith({ forward: async () => response(200), exec, onDisconnect }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 50, probeTimeoutMs: 20 },
    );

    expect(result).toEqual({ ready: true, via: "forward" });
    expect(exec).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ["a connection reset", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    [
      "an SSH connection refusal",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    ],
    ["an SSH handshake failure", new Error("Timed out while waiting for handshake")],
    ["exhausted SSH resources", Object.assign(new Error("SSH resource shortage"), { reason: 4 })],
  ] as const)("reports %s as unverified, without blaming the app", async (_label, error) => {
    const forward = vi.fn(async () => {
      throw error;
    });
    const exec = vi.fn();
    const unsubscribe = vi.fn();

    const result = await waitForReadyFromExecutor(
      executorWith({ forward, exec, onDisconnect: () => unsubscribe }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 20, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(result).toEqual({
      ready: false,
      via: "forward",
      unverifiable: expect.stringContaining(error.message),
    });
    expect(forward).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "disconnect"])(
    "reports an opening-channel %s as unverified and destroys a late stream",
    async (cause) => {
      vi.useFakeTimers();
      let resolveForward!: (stream: Duplex) => void;
      let disconnect!: (error: Error) => void;
      const unsubscribe = vi.fn();
      const forward = vi.fn(
        () =>
          new Promise<Duplex>((resolve) => {
            resolveForward = resolve;
          }),
      );
      const pending = waitForReadyFromExecutor(
        executorWith({
          forward,
          onDisconnect: (cb) => {
            disconnect = cb;
            return unsubscribe;
          },
        }),
        "127.0.0.1",
        20_000,
        { path: "/ready", timeoutMs: 1_000, probeTimeoutMs: 20 },
      );

      await vi.advanceTimersByTimeAsync(0);
      if (cause === "timeout") await vi.advanceTimersByTimeAsync(20);
      else disconnect(new Error("SSH connection lost"));

      expect(await pending).toEqual({
        ready: false,
        via: "forward",
        unverifiable: expect.stringContaining(
          cause === "timeout" ? "timed out opening" : "SSH connection lost",
        ),
      });
      const stream = response(200);
      resolveForward(stream);
      await vi.advanceTimersByTimeAsync(0);

      expect(stream.destroyed).toBe(true);
      expect(forward).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops an HTTP probe when SSH disconnects and cleans up its stream and subscription", async () => {
    vi.useFakeTimers();
    const stream = silentStream();
    let disconnect!: (error: Error) => void;
    const unsubscribe = vi.fn();
    const pending = waitForReadyFromExecutor(
      executorWith({
        forward: async () => stream,
        onDisconnect: (cb) => {
          disconnect = cb;
          return unsubscribe;
        },
      }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 5_000, probeTimeoutMs: 2_000 },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(stream.destroyed).toBe(false);
    disconnect(new Error("SSH connection lost during HTTP response"));

    expect(await pending).toEqual({
      ready: false,
      via: "forward",
      unverifiable: expect.stringContaining("SSH connection lost during HTTP response"),
    });
    expect(stream.destroyed).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying an app refusal if SSH disconnects between attempts", async () => {
    vi.useFakeTimers();
    let disconnect!: (error: Error) => void;
    const forward = vi.fn(async () => {
      throw connectionRefused();
    });
    const unsubscribe = vi.fn();
    const pending = waitForReadyFromExecutor(
      executorWith({
        forward,
        onDisconnect: (cb) => {
          disconnect = cb;
          return unsubscribe;
        },
      }),
      "127.0.0.1",
      20_000,
      { timeoutMs: 5_000, intervalMs: 1_000 },
    );

    await vi.advanceTimersByTimeAsync(0);
    disconnect(new Error("SSH connection lost between attempts"));

    expect((await pending).unverifiable).toContain("SSH connection lost between attempts");
    expect(forward).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails readiness when the connected app never answers HTTP and SSH stays connected", async () => {
    vi.useFakeTimers();
    const stream = silentStream();
    const unsubscribe = vi.fn();
    const pending = waitForReadyFromExecutor(
      executorWith({ forward: async () => stream, onDisconnect: () => unsubscribe }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 20, probeTimeoutMs: 20 },
    );

    await vi.advanceTimersByTimeAsync(20);

    expect(await pending).toEqual({ ready: false, via: "forward" });
    expect(stream.destroyed).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  // The GH-583 install: exec works, forwarding is refused. The app IS healthy, and the
  // deploy must see that rather than be told the app never answered.
  it("falls back to a host-side curl when forwarding is refused", async () => {
    const result = await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        exec: async () => "OPENSHIP_PROBE 200 1",
      }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 200, intervalMs: 1, probeTimeoutMs: 20 },
    );

    expect(result).toEqual({ ready: true, via: "exec" });
  });

  it("reports a genuinely dead app through the fallback too", async () => {
    const result = await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        // No HTTP response and no connection: nothing is listening.
        exec: async () => "OPENSHIP_PROBE 000 0",
      }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 20, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(result.ready).toBe(false);
    expect(result.unverifiable).toBeUndefined();
  });

  // A TCP-only gate asks one thing: did the handshake complete? An app that accepts a
  // connection and then speaks a non-HTTP protocol (curl: empty reply, no status) passes,
  // matching what the forwarded probe does with a bare accept.
  it("accepts a connected-but-not-HTTP port when no path is configured", async () => {
    const result = await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        exec: async () => "OPENSHIP_PROBE 000 1",
      }),
      "127.0.0.1",
      20_000,
      { timeoutMs: 50, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(result).toEqual({ ready: true, via: "exec" });
  });

  // The false POSITIVE this branch used to have. Reading "curl didn't exit 7" as "it
  // connected" made a timeout look like a successful handshake — and curl times out both
  // before AND after connecting, so a dropped SYN on a bridge IP reported a dead workload
  // as ready. `num_connects: 0` is unambiguous.
  it("does NOT accept a timeout that never completed a handshake", async () => {
    const result = await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        // curl exit 28 with nothing connected — the SYN went unanswered.
        exec: async () => "OPENSHIP_PROBE 000 0",
      }),
      "10.0.0.9",
      8080,
      { timeoutMs: 20, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(result.ready).toBe(false);
    expect(result.unverifiable).toBeUndefined();
  });

  // The budget the caller promised the operator ("waiting up to Ns") must cover BOTH
  // mechanisms, not be spent twice.
  it("gives the fallback what is left of the timeout, not a fresh copy", async () => {
    let lastMaxTime = "";
    const startedAt = Date.now();
    await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        exec: async (command) => {
          lastMaxTime = /--max-time '(\d+)'/.exec(command)?.[1] ?? "";
          return "OPENSHIP_PROBE 000 0";
        },
      }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 1_200, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(lastMaxTime).not.toBe("");
    // Both phases inside one budget (plus scheduling slack), never ~2x it.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  // Neither mechanism could ASK. That is not a failed app — the caller must warn, and
  // `unverifiable` is what tells it so.
  it("returns unverifiable — not 'not ready' — when the host has no curl either", async () => {
    const result = await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        exec: async () => "OPENSHIP_PROBE_NO_CLIENT",
      }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 50, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(result.ready).toBe(false);
    expect(result.via).toBe("exec");
    expect(result.unverifiable).toContain("refuses port forwarding");
    expect(result.unverifiable).toContain("no `curl`");
  });

  it("reports unverifiable when the channel itself fails mid-probe", async () => {
    const result = await waitForReadyFromExecutor(
      executorWith({
        forward: async () => {
          throw prohibited();
        },
        exec: async () => {
          throw new Error("socket hang up");
        },
      }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 50, intervalMs: 1, probeTimeoutMs: 10 },
    );

    expect(result.unverifiable).toContain("socket hang up");
  });
});
