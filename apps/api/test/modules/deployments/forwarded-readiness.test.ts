import { describe, expect, it, vi } from "vitest";
import { Duplex } from "node:stream";
import {
  buildHostProbeCommand,
  isForwardingProhibited,
  parseHostProbeOutput,
  waitForForwardedReady,
  waitForReadyFromExecutor,
} from "../../../src/modules/deployments/forwarded-readiness";
import type { CommandExecutor } from "@repo/adapters";

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
        throw new Error("ECONNREFUSED");
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
}): CommandExecutor {
  return {
    ...(opts.forward ? { forwardPort: opts.forward } : {}),
    exec: opts.exec ?? (async () => ""),
  } as unknown as CommandExecutor;
}

describe("waitForReadyFromExecutor", () => {
  it("uses the forwarded channel when the server allows it", async () => {
    const exec = vi.fn();
    const result = await waitForReadyFromExecutor(
      executorWith({ forward: async () => response(200), exec }),
      "127.0.0.1",
      20_000,
      { path: "/ready", timeoutMs: 50, probeTimeoutMs: 20 },
    );

    expect(result).toEqual({ ready: true, via: "forward" });
    expect(exec).not.toHaveBeenCalled();
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
