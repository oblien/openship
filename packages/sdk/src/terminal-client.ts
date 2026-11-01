import { reportError } from "@repo/core/diagnostics";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalTargetSchema,
  TerminalTicketSchema,
  TerminalControlSchema,
  parseInput,
  TERMINAL_SUBPROTOCOL_PREFIX,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX,
  TERMINAL_COLS_MAX,
  TERMINAL_ROWS_MAX,
  type TerminalTarget,
  type TerminalReady,
  type TerminalExit,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { ApiError } from "./errors";

/** Browser-compatible socket boundary; Node callers may supply a factory with an Origin header. */
export interface TerminalSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close", listener: (event: { code: number }) => void): void;
  removeEventListener(type: "error", listener: () => void): void;
}
export interface TerminalOptions {
  onData: (data: Uint8Array) => void;
  /** Node: the instance's trusted dashboard origin. Browsers send their origin automatically. */
  origin?: string;
  signal?: AbortSignal;
  /** Defaults to 30 seconds; this bounds ticket issuance and shell readiness. */
  connectTimeoutMs?: number;
  /** An explicit resume never falls back to opening an additional shell. */
  resumeToken?: string;
  createWebSocket?: (url: string, protocols: string[]) => TerminalSocket;
}
export interface TerminalSession extends TerminalReady {
  /** Resolves only for a confirmed shell exit or explicit client close. */
  readonly closed: Promise<TerminalExit>;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Permanently closes the remote shell, rather than leaving it parked. */
  close(): void;
}
export interface TerminalOperations {
  openServer(id: string, options: TerminalOptions): Promise<TerminalSession>;
  openService(id: string, options: TerminalOptions): Promise<TerminalSession>;
}

export function createRemoteTerminalOperations(http: HttpClient): TerminalOperations {
  async function open(value: TerminalTarget, options: TerminalOptions): Promise<TerminalSession> {
    options = Object.freeze({ ...options });
    const target = parseInput(TerminalTargetSchema, value);
    const timeout = options.connectTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
      throw new TypeError("connectTimeoutMs must be a positive integer within the timer range");
    if (typeof options.onData !== "function")
      throw new TypeError("onData is required for terminal output");
    if (options.resumeToken !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(options.resumeToken))
      throw new TypeError("Invalid terminal resume token");
    if (options.origin !== undefined && options.createWebSocket)
      throw new TypeError("Choose origin or a custom WebSocket factory");
    options.signal?.throwIfAborted();
    let createSocket = options.createWebSocket;
    if (!createSocket && options.origin !== undefined) {
      const origin = new URL(options.origin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash
      )
        throw new TypeError(
          "origin must be an HTTP(S) dashboard URL without credentials, query or fragment",
        );
      // Lazy Node transport keeps browser users on the browser's own Origin and
      // WebSocket implementation. Its ticket is never forwarded by a redirect.
      const { WebSocket } = await import("ws");
      createSocket = (url, protocols) =>
        new WebSocket(url, protocols, {
          origin: origin.origin,
          followRedirects: false,
          maxPayload: 8 * 1024 * 1024,
        });
    }
    createSocket ??= (address, protocols) => new globalThis.WebSocket(address, protocols);
    options.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeout);
    const handshakeSignal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const path = target.kind === "server" ? "/terminal" : "/services/terminal";
    const response = await http.request(path + "/ticket", {
      method: "POST",
      body: JSON.stringify({ [target.kind + "Id"]: target.id }),
      signal: handshakeSignal,
    });
    if (!Value.Check(TerminalTicketSchema, response))
      throw new ApiError("Invalid terminal ticket response", 502, null);
    handshakeSignal.throwIfAborted();
    const url = http.url(`${path}/ws/${encodeURIComponent(target.id)}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const protocols = [TERMINAL_SUBPROTOCOL_PREFIX + response.token];
    if (options.resumeToken)
      protocols.push(TERMINAL_RESUME_SUBPROTOCOL_PREFIX + options.resumeToken);
    const socket = createSocket(url.href, protocols);
    socket.binaryType = "arraybuffer";

    let ready: TerminalReady | undefined;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let resolveReady!: (session: TerminalSession) => void;
    let rejectReady!: (error: unknown) => void;
    let resolveClosed!: (exit: TerminalExit) => void;
    let rejectClosed!: (error: unknown) => void;
    const opened = new Promise<TerminalSession>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const closed = new Promise<TerminalExit>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    // Failure before readiness has no returned session on which to observe closed.
    void closed.catch(() => {
      /* diagnostics-ignore: Terminal finish rejects the caller promises; close/ping cleanup is expected after disconnection. */
});

    function finish(error?: unknown, exit?: TerminalExit) {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      deadline.removeEventListener("abort", timedOut);
      options.signal?.removeEventListener("abort", aborted);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", disconnected);
      if (error !== undefined) {
        reportError(error, { source: "sdk", kind: "operation", component: "sdk-terminal", handled: true });
        rejectReady(error);
        rejectClosed(error);
      } else if (exit) resolveClosed(exit);
      // Keep the error listener until close has run: some Node sockets emit an
      // asynchronous error when closed during the handshake.
      try {
        socket.close(1000, "client_close");
      } catch {
      /* diagnostics-ignore: Terminal finish rejects the caller promises; close/ping cleanup is expected after disconnection. */

        /* Already closed. */
      }
    }
    function terminate() {
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: "close" }));
        } catch {
      /* diagnostics-ignore: Terminal finish rejects the caller promises; close/ping cleanup is expected after disconnection. */

          /* Transport already failed. */
        }
      }
    }
    function aborted() {
      terminate();
      finish(options.signal?.reason ?? new Error("Terminal aborted"));
    }
    function timedOut() {
      terminate();
      finish(new Error("Terminal connection timed out before the shell was ready"));
    }
    function transportError() {
      terminate();
      finish(new ApiError("Terminal WebSocket connection failed", 0, null));
    }
    function disconnected(event: { code: number }) {
      finish(
        new ApiError(
          `Terminal connection closed before a shell exit was confirmed (${event.code})`,
          0,
          null,
        ),
      );
    }
    function send(data: string | Uint8Array) {
      if (!ready || settled || socket.readyState !== 1)
        throw new Error("Terminal is not connected");
      socket.send(data);
    }
    function message(event: { data: unknown }) {
      if (settled) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          options.onData(new Uint8Array(event.data));
          return;
        }
        if (ArrayBuffer.isView(event.data)) {
          options.onData(
            new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
          );
          return;
        }
        if (typeof event.data !== "string") throw new Error("Invalid terminal message");
        const control: unknown = JSON.parse(event.data);
        if (!Value.Check(TerminalControlSchema, control))
          throw new Error("Invalid terminal control message");
        if (control.type === "error") {
          terminate();
          finish(new ApiError(control.message, 0, { code: control.code }));
          return;
        }
        if (control.type === "exit") {
          if (!ready) {
            finish(new Error("Terminal exited before opening"));
            return;
          }
          finish(undefined, control);
          return;
        }
        if (control.type !== "ready") return;
        if (ready) throw new Error("Duplicate terminal readiness message");
        ready = control;
        deadline.removeEventListener("abort", timedOut);
        heartbeat = setInterval(() => {
          try {
            send(JSON.stringify({ type: "ping" }));
          } catch {
      /* diagnostics-ignore: Terminal finish rejects the caller promises; close/ping cleanup is expected after disconnection. */

            transportError();
          }
        }, 25_000);
        resolveReady(
          Object.freeze({
            ...control,
            closed,
            write(data: string | Uint8Array) {
              send(typeof data === "string" ? new TextEncoder().encode(data) : data);
            },
            resize(cols: number, rows: number) {
              if (
                !Number.isSafeInteger(cols) ||
                cols < 1 ||
                cols > TERMINAL_COLS_MAX ||
                !Number.isSafeInteger(rows) ||
                rows < 1 ||
                rows > TERMINAL_ROWS_MAX
              )
                throw new RangeError("Terminal dimensions are outside the supported range");
              send(JSON.stringify({ type: "resize", cols, rows }));
            },
            close() {
              terminate();
              finish(undefined, { type: "exit", code: null, signal: "client_close" });
            },
          }),
        );
      } catch (error) {
        terminate();
        finish(error);
      }
    }
    socket.addEventListener("message", message);
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", transportError);
    deadline.addEventListener("abort", timedOut, { once: true });
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (handshakeSignal.aborted) {
      if (options.signal?.aborted) aborted();
      else timedOut();
    }
    return opened;
  }
  return Object.freeze({
    openServer: (id, options) => open({ kind: "server", id }, options),
    openService: (id, options) => open({ kind: "service", id }, options),
  } satisfies TerminalOperations);
}
