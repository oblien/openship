import net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createDockerSshBridge } from "./docker-ssh-agent";
import type { DockerConnectionOptions } from "./docker-transport";

/**
 * Two things are guarded here, and the second is why the first ever mattered.
 *
 * 1. One dead Docker request must never kill the API process. `captureClient.fail()` used
 *    to `client.destroy(err)` after detaching the socket's only 'error' listener — an
 *    unhandled 'error' event that killed every project's tabs, not just the one failing
 *    request.
 * 2. A dead request must SAY WHY. A destroyed socket carries no cause: dockerode turns it
 *    into `socket hang up`, which is all a host with no running dockerd (the Amazon Linux
 *    report) ever showed. The bridge now writes a real HTTP 502 whose JSON body is the
 *    reason — the daemon's own stderr wherever there is any.
 *
 * A configured `dockerSocketPath` skips remote discovery and a failing `forwardUnixSocket`
 * drives the bridge to dial-stdio, so these paths run deterministically with no real ssh2.
 */
describe("createDockerSshBridge — a failed request is answered, not reset", () => {
  const bridges: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const b of bridges.splice(0)) b.close();
  });

  function bridgeWith(openDockerDialStdio: () => Promise<Duplex>) {
    const bridge = createDockerSshBridge({
      host: "test-host",
      username: "root",
      // Skip remote socket discovery so the executor mock needs no `exec`.
      dockerSocketPath: "/var/run/docker.sock",
      executor: {
        // streamlocal probe rejects → the bridge commits to dial-stdio…
        forwardUnixSocket: (): Promise<Duplex> =>
          Promise.reject(new Error("streamlocal forwarding refused")),
        openDockerDialStdio,
      },
    } as unknown as DockerConnectionOptions);
    bridges.push(bridge);
    return bridge;
  }

  /** An ssh2-shaped exec channel: a separate `stderr` Readable, an `exit` event, and a
   *  writable side that swallows the request (a PassThrough would echo the request back
   *  and read as a response). */
  function fakeChannel() {
    const channel = new Duplex({
      read() {},
      write(_chunk, _enc, cb) {
        cb();
      },
    }) as Duplex & { stderr: PassThrough };
    channel.stderr = new PassThrough();
    return channel;
  }

  /** A tiny Docker-shaped channel that answers after `delayMs`. Delaying only the first
   *  probe lets the test distinguish the cached transport without involving real SSH. */
  function httpChannel(body: string, delayMs = 0) {
    let answered = false;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = new Duplex({
      read() {},
      write(_chunk, _enc, cb) {
        if (!answered) {
          answered = true;
          responseTimer = setTimeout(() => {
            channel.push(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
            // Let the bridge attach its post-first-byte pipe before EOF arrives.
            setImmediate(() => channel.push(null));
          }, delayMs);
        }
        cb();
      },
    });
    channel.once("close", () => {
      if (responseTimer) clearTimeout(responseTimer);
    });
    return channel;
  }

  /** Send one Docker API request through a started bridge and return the whole raw reply.
   *  `start()` binds the listener and is called once per bridge, as the transport does. */
  async function request(bridge: { start: () => Promise<{ host: string; port: number }> }) {
    return requestAt(await bridge.start());
  }

  function requestAt({ host, port }: { host: string; port: number }) {
    return new Promise<string>((resolve) => {
      let reply = "";
      const timer = setTimeout(() => resolve(reply), 8_000);
      const sock = net.connect(port, host, () => {
        sock.write("GET /_ping HTTP/1.1\r\nHost: localhost\r\n\r\n");
      });
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        reply += chunk;
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  /** A user listener is what stands between the old behavior and a killed worker: with one
   *  present Node routes an unhandled 'error' here instead of aborting, so we can ASSERT
   *  none fired rather than just crashing. */
  async function withUncaughtWatch(body: () => Promise<void>): Promise<unknown[]> {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      await body();
      // Let any queued 'error' emission surface before the caller asserts on it.
      await new Promise((r) => setTimeout(r, 50));
      return uncaught;
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  }

  it("answers 502 with the cause when no upstream can be opened — and never crashes", async () => {
    let reply = "";
    const uncaught = await withUncaughtWatch(async () => {
      const bridge = bridgeWith(() =>
        Promise.reject(new Error("SSH key authentication failed for root@test-host")),
      );
      reply = await request(bridge);
    });

    expect(uncaught).toEqual([]);
    expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
    expect(reply).toContain("SSH key authentication failed for root@test-host");
    // Named host: a multi-server dashboard has to say WHICH box failed.
    expect(reply).toContain("test-host");
  });

  it("survives a second failing request on the same bridge", async () => {
    const replies: string[] = [];
    const uncaught = await withUncaughtWatch(async () => {
      const bridge = bridgeWith(() => Promise.reject(new Error("SSH key authentication failed")));
      const address = await bridge.start();
      for (let i = 0; i < 2; i++) replies.push(await requestAt(address));
    });

    expect(uncaught).toEqual([]);
    expect(replies).toHaveLength(2);
    for (const reply of replies) expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
  });

  it("reports the daemon's own words when dial-stdio dies — the socket-hang-up bug", async () => {
    // The reported failure, reproduced: dockerd was never running (the host's distro fell
    // outside the install allowlist). `docker system dial-stdio` says exactly that on
    // stderr and exits non-zero; all the operator used to see was `socket hang up`.
    const reply = await request(
      bridgeWith(async () => {
        const channel = fakeChannel();
        setImmediate(() => {
          channel.stderr.write(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
          );
          channel.emit("exit", 1);
          setImmediate(() => channel.destroy());
        });
        return channel;
      }),
    );

    expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
    expect(reply).toContain("Cannot connect to the Docker daemon");
    expect(reply).toContain("exit code 1");
  });

  it("names a forced command that answers instead of the daemon", async () => {
    // The AWS AMI root key: an authorized_keys `command=` that echoes a banner intercepts
    // every exec, so dial-stdio's stdout carries prose, not an HTTP response. Piped
    // through, dockerode reports an unparseable body about nothing.
    const reply = await request(
      bridgeWith(async () => {
        const channel = fakeChannel();
        setImmediate(() =>
          channel.push('Please login as the user "ec2-user" rather than the user "root".\n'),
        );
        return channel;
      }),
    );

    expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
    expect(reply).toContain("ec2-user");
    expect(reply).toContain("forced command");
  });

  it("answers 502 when a slow channel EOFs without responding", async () => {
    // The other half of the reset bug, on the pipe rather than the open. A dial-stdio
    // channel that takes longer than DIAL_STDIO_ANSWER_TIMEOUT_MS to fail is COMMITTED
    // unanswered (silence proves nothing — /events is silent for minutes), so its cause
    // has to come out of `pipeThrough`. EOF is how such a channel ends, and pipe's
    // default end-on-EOF closed the socket's writable side first, so the 502 was dropped
    // and the operator got `socket hang up` anyway.
    const reply = await request(
      bridgeWith(async () => {
        const channel = fakeChannel();
        setTimeout(() => {
          channel.stderr.write(
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
          );
          channel.emit("exit", 1);
          channel.push(null); // EOF first, close after — the real ssh2 order
          setImmediate(() => channel.destroy());
        }, 3_400); // > DIAL_STDIO_ANSWER_TIMEOUT_MS, so the socket is committed unanswered
        return channel;
      }),
    );

    expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
    expect(reply).toContain("permission denied");
  }, 20_000);

  it("answers 502 when a committed channel ERRORS instead of EOFing", async () => {
    // The same committed-unanswered channel as above, ending the other way it can end.
    // An `error` on the upstream ran the shared teardown, which destroyed the CLIENT
    // socket — and `respondBadGateway` refuses a destroyed socket, so the `close` that
    // followed answered nothing and dockerode got `socket hang up` regardless. The 502
    // was reachable only for an upstream that failed POLITELY, while a reset peer, a
    // killed exec and a broken channel all arrive as an error.
    //
    // Before the answer window this is unreachable — `awaitFirstByte` classifies an early
    // error as `closed` and fails there. It is only after the commit that `pipeThrough`
    // owns the outcome, which is exactly the window the sibling test above covers for EOF.
    const reply = await request(
      bridgeWith(async () => {
        const channel = fakeChannel();
        setTimeout(() => {
          channel.stderr.write(
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
          );
          channel.emit("exit", 1);
          channel.destroy(new Error("channel closed by peer"));
        }, 3_400);
        return channel;
      }),
    );

    expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
    expect(reply).toContain("permission denied");
  }, 20_000);

  it("leaves a real response alone, including the close that follows it", async () => {
    // The other half of the invariant: a 502 may only replace a response that never
    // started. Once a byte has gone client-ward an upstream close is the end of a
    // successful reply, and appending a status line there would corrupt it.
    const reply = await request(
      bridgeWith(async () => {
        const channel = fakeChannel();
        setImmediate(() => {
          channel.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
          setImmediate(() => channel.destroy());
        });
        return channel;
      }),
    );

    expect(reply).toBe("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    expect(reply).not.toContain("502");
  });

  it("does not drop a multi-chunk response between verification and piping", async () => {
    // ssh2 commonly delivers channel data in ~32 KiB frames. awaitFirstByte used
    // to remove its only `data` listener while leaving the channel in flowing
    // mode; a second frame emitted before the promise continuation installed the
    // pipe was discarded. dockerode then waited forever for Content-Length.
    const body = "x".repeat(96 * 1024);
    const header = `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`;
    const reply = await request(
      bridgeWith(async () => {
        const channel = fakeChannel();
        setImmediate(() => {
          channel.push(header + body.slice(0, 32 * 1024));
          channel.push(body.slice(32 * 1024, 64 * 1024));
          channel.push(body.slice(64 * 1024));
          setImmediate(() => channel.push(null));
        });
        return channel;
      }),
    );

    expect(reply).toBe(header + body);
  });

  it("does not select streamlocal when its probe exceeds the real-channel verify window", async () => {
    let streamlocalOpens = 0;
    let dialStdioOpens = 0;
    const bridge = createDockerSshBridge({
      host: "test-host",
      username: "root",
      dockerSocketPath: "/var/run/docker.sock",
      executor: {
        forwardUnixSocket: async (): Promise<Duplex> => {
          streamlocalOpens += 1;
          // The capability probe answers after the 3s deadline used by every real
          // streamlocal channel. Accepting it under the old 8s probe deadline cached a
          // transport that the bridge itself considered unusable for later requests.
          return httpChannel("probe", streamlocalOpens === 1 ? 3_200 : 0);
        },
        openDockerDialStdio: async (): Promise<Duplex> => {
          dialStdioOpens += 1;
          return httpChannel("dial-stdio");
        },
      },
    } as unknown as DockerConnectionOptions);
    bridges.push(bridge);

    await bridge.probe();
    const reply = await request(bridge);

    expect(reply).toContain("dial-stdio");
    expect(streamlocalOpens).toBe(1);
    expect(dialStdioOpens).toBe(1);
  }, 15_000);

  /**
   * Downgrading streamlocal → dial-stdio REPLAYS the buffered request, which is only free
   * for a read. The bridge used to replay on silence too, and silence is the normal shape
   * of a slow write: `POST /containers/{id}/restart` says nothing until dockerd has
   * stopped and started the container, well past the 3s verify window. The container was
   * restarted twice — once by the channel that was working all along, once by the replay.
   */
  describe("streamlocal channel that is slow rather than dead", () => {
    /** A streamlocal channel that records the request and answers whenever told to. */
    function recordingChannel(sink: string[]) {
      const channel = new Duplex({
        read() {},
        write(chunk: Buffer, _enc, cb) {
          sink.push(chunk.toString("utf8"));
          cb();
        },
      });
      return channel;
    }

    /** Bridge whose streamlocal probe SUCCEEDS (so the bridge picks streamlocal), then
     *  hands the real request to `channel`. */
    function streamlocalBridge(channel: Duplex) {
      let forwards = 0;
      const bridge = createDockerSshBridge({
        host: "test-host",
        username: "root",
        dockerSocketPath: "/var/run/docker.sock",
        executor: {
          forwardUnixSocket: async (): Promise<Duplex> => {
            forwards += 1;
            if (forwards > 1) return channel;
            // decideMode's /_ping probe — answering it commits the bridge to streamlocal.
            const probe = new Duplex({
              read() {},
              write(_chunk, _enc, cb) {
                probe.push("HTTP/1.1 200 OK\r\n\r\n");
                cb();
              },
            });
            return probe;
          },
        },
      } as unknown as DockerConnectionOptions);
      bridges.push(bridge);
      return bridge;
    }

    function requestAtWith({ host, port }: { host: string; port: number }, head: string) {
      return new Promise<string>((resolve) => {
        let reply = "";
        const timer = setTimeout(() => resolve(reply), 12_000);
        const sock = net.connect(port, host, () => sock.write(head));
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => {
          reply += chunk;
        });
        sock.on("error", () => {});
        sock.on("close", () => {
          clearTimeout(timer);
          resolve(reply);
        });
      });
    }

    const RESTART = "POST /v1.43/containers/web/restart HTTP/1.1\r\nHost: localhost\r\n\r\n";

    it("delivers a late write response instead of re-dispatching it", async () => {
      const dispatched: string[] = [];
      const channel = recordingChannel(dispatched);
      // Answers after the 3s per-channel verify window — a normal container restart.
      setTimeout(() => {
        channel.push("HTTP/1.1 204 No Content\r\n\r\n");
        channel.push(null); // EOF after a real response must still end the socket cleanly
      }, 4_200);

      const reply = await requestAtWith(await streamlocalBridge(channel).start(), RESTART);

      expect(reply).toContain("HTTP/1.1 204 No Content");
      expect(dispatched.join("")).toContain("/restart");
      // The whole point: exactly one dispatch of a non-idempotent request.
      expect(dispatched.filter((chunk) => chunk.includes("/restart"))).toHaveLength(1);
    }, 25_000);

    it("still downgrades on a silent read, where replaying costs nothing", async () => {
      const dispatched: string[] = [];
      const channel = recordingChannel(dispatched);

      // No `openDockerDialStdio` on the executor and no reachable host, so the downgrade's
      // fresh SSH connection fails — the 502 is the proof it was attempted at all.
      const reply = await requestAtWith(
        await streamlocalBridge(channel).start(),
        "GET /v1.43/containers/json HTTP/1.1\r\nHost: localhost\r\n\r\n",
      );

      expect(reply).toContain("HTTP/1.1 502 Bad Gateway");
      expect(channel.destroyed).toBe(true);
    }, 25_000);
  });
});

/**
 * Which socket the remote daemon listens on is DISCOVERED, and the answer is cached per
 * connection-options object. A discovery that failed used to be recorded as if it had
 * answered `/var/run/docker.sock`: one transport blip, one timeout, or an sshd forced
 * command running instead of the probe script, and every later request for the lifetime
 * of that options object aimed at a socket a rootless or podman-only host does not have —
 * with no re-probe, so the box looked permanently broken.
 *
 * The fallback itself is right; caching it is not. Two bridges built from the SAME options
 * object share the cache entry, which is how a re-probe is observable here.
 */
describe("the discovered docker socket path", () => {
  const bridges: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const b of bridges.splice(0)) b.close();
  });

  /** `forwardUnixSocket` records the path discovery chose, then rejects so the probe
   *  stops there — the recorded path is all this needs. */
  function probeTwice(exec: (n: number) => Promise<string>) {
    const aimedAt: string[] = [];
    let execCalls = 0;
    const opts = {
      host: "test-host",
      username: "root",
      executor: {
        exec: () => exec(++execCalls),
        forwardUnixSocket: (socketPath: string): Promise<Duplex> => {
          aimedAt.push(socketPath);
          return Promise.reject(new Error("streamlocal forwarding refused"));
        },
      },
    } as unknown as DockerConnectionOptions;

    return {
      aimedAt,
      execCalls: () => execCalls,
      async run() {
        for (let i = 0; i < 2; i++) {
          const bridge = createDockerSshBridge(opts);
          bridges.push(bridge);
          await bridge.probe().catch(() => {});
        }
      },
    };
  }

  it("re-probes after a failed discovery instead of keeping the fallback", async () => {
    const probe = probeTwice(async (n) => {
      if (n === 1) throw new Error("ssh: connection reset by peer");
      return "/run/user/1000/docker.sock\n";
    });

    await probe.run();

    // The failed probe still falls back — a request has to be attempted somewhere.
    expect(probe.aimedAt[0]).toBe("/var/run/docker.sock");
    // …but the fallback was not remembered, so the rootless socket is found on the retry.
    expect(probe.aimedAt[1]).toBe("/run/user/1000/docker.sock");
    expect(probe.execCalls()).toBe(2);
  }, 20_000);

  it("caches a probe that ANSWERED, including one that found nothing", async () => {
    // The other half: un-poisoning must not become "probe on every connection". An empty
    // answer is a reading — this box really has no socket in any known place.
    const probe = probeTwice(async () => "");

    await probe.run();

    expect(probe.aimedAt).toEqual(["/var/run/docker.sock", "/var/run/docker.sock"]);
    expect(probe.execCalls()).toBe(1);
  }, 20_000);
});
