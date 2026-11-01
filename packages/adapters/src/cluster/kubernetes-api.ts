import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import tls from "node:tls";
import net from "node:net";
import { PassThrough, type Duplex } from "node:stream";
// Explicit entry avoids Bun's incomplete built-in `undici` compatibility shim.
import { Pool } from "undici/index.js";
import { AppError } from "@repo/core";

export interface KubernetesObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    generation?: number;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
    ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string }>;
  };
  [key: string]: any;
}

export interface KubernetesApi {
  request<T = KubernetesObject>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  watch(
    path: string,
    signal: AbortSignal,
  ): AsyncIterable<{ type: string; object: KubernetesObject }>;
  logs(path: string, signal: AbortSignal): AsyncIterable<string>;
  dispose(): Promise<void>;
}

export class KubernetesApiError extends AppError {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(
      message,
      statusCode === 404 ? 404 : statusCode === 409 ? 409 : 502,
      "KUBERNETES_API_ERROR",
    );
  }
}

interface ApiResponse {
  statusCode: number;
  chunks: AsyncIterable<Uint8Array>;
  destroy(): void;
}

/** A verified TLS API connection over a pooled host channel. No kubectl per pod,
 * no public API listener and no automatic replay of an ambiguous mutation. */
export function createKubernetesApi(options: {
  host: string;
  ca: string;
  cert: string;
  key: string;
  connect: () => Promise<Duplex>;
}): KubernetesApi {
  const lifetime = new AbortController();
  const sockets = new Set<Duplex>();
  let channelError: Error | undefined;
  // Bun's HTTPS client bypasses Agent.createConnection. Like the Docker
  // transport, use a loopback TCP bridge; TLS stays encrypted through it and
  // is verified against the real private API identity, not the loopback name.
  const bridge = net.createServer((client) => {
    sockets.add(client);
    client.setNoDelay(true);
    const pending = new PassThrough({ highWaterMark: 64 * 1024 });
    // Attach before awaiting SSH: Bun can drop early bytes on an unread socket.
    client.pipe(pending);
    let upstream: Duplex | undefined;
    const close = () => {
      clearTimeout(timer);
      pending.destroy();
      client.destroy();
      upstream?.destroy();
      sockets.delete(client);
      if (upstream) sockets.delete(upstream);
    };
    const timer = setTimeout(() => {
      channelError = new Error("The private Kubernetes API connection timed out");
      close();
    }, 30_000);
    timer.unref();
    client.on("error", close);
    client.once("close", close);
    void options.connect().then(
      (socket) => {
        if (client.destroyed || lifetime.signal.aborted) {
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        channelError = undefined;
        upstream = socket;
        sockets.add(socket);
        socket.on("error", (error) => { observeCaughtError(error, "adapters/cluster/kubernetes-api");
          channelError = error;
          close();
        });
        socket.once("close", close);
        socket.pipe(client);
        pending.pipe(socket);
      },
      (error) => {
        observeCaughtError(error, "adapters/cluster/kubernetes-api");
        channelError = error instanceof Error ? error : new Error(String(error));
        close();
      },
    );
  });
  bridge.on("error", (error) => { observeCaughtError(error, "adapters/cluster/kubernetes-api");
    channelError = error;
  });
  let address: Promise<number> | undefined;
  const listen = () =>
    (address ??= new Promise<number>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      bridge.once("error", failed);
      bridge.listen(0, "127.0.0.1", () => {
        bridge.removeListener("error", failed);
        if (lifetime.signal.aborted) {
          bridge.close();
          reject(new Error("Cluster connection closed"));
          return;
        }
        bridge.unref();
        resolve((bridge.address() as net.AddressInfo).port);
      });
    }));
  let pool: Pool | undefined;
  const dispatcher = (port: number) =>
    (pool ??= new Pool(`https://127.0.0.1:${port}`, {
      connections: 8,
      pipelining: 1,
      connect: (_options, callback) => {
        // Do not let an HTTP implementation send the request before identity
        // verification: Bun's node:https/fetch shims verify custom names too late.
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          ca: options.ca,
          cert: options.cert,
          key: options.key,
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, peer) => tls.checkServerIdentity(options.host, peer),
        });
        sockets.add(socket);
        let answered = false;
        const timer = setTimeout(
          () => socket.destroy(new Error("The Kubernetes TLS handshake timed out")),
          30_000,
        );
        timer.unref();
        const fail = (error: Error) => {
          clearTimeout(timer);
          if (!answered) {
            answered = true;
            callback(error, null);
          }
        };
        socket.on("error", fail);
        socket.once("close", () => {
          sockets.delete(socket);
          fail(new Error("The Kubernetes TLS connection closed"));
        });
        socket.once("secureConnect", () => {
          const error = !socket.authorized
            ? new Error(String(socket.authorizationError ?? "Untrusted Kubernetes certificate"))
            : tls.checkServerIdentity(options.host, socket.getPeerCertificate());
          if (error) {
            socket.destroy(error);
            return;
          }
          clearTimeout(timer);
          if (!answered) {
            answered = true;
            callback(null, socket);
          }
        });
      },
    }));
  async function open(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    streaming = false,
  ): Promise<ApiResponse> {
    if (!(path === "/version" && method === "GET") && path !== "/apis" && !path.startsWith("/api/") && !path.startsWith("/apis/"))
      throw new Error("Invalid Kubernetes API path");
    const combined = AbortSignal.any([
      lifetime.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(streaming ? 90_000 : 30_000),
    ]);
    combined.throwIfAborted();
    const port = await listen();
    combined.throwIfAborted();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Accept: "application/json",
      ...(encoded
        ? {
            "Content-Type":
              method === "PATCH" ? "application/merge-patch+json" : "application/json",
            "Content-Length": String(Buffer.byteLength(encoded)),
          }
        : {}),
    };
    const response = await dispatcher(port)
      .request({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        path,
        headers,
        body: encoded,
        signal: combined,
        // In particular, never replay a mutation after an ambiguous response.
        idempotent: false,
      })
      .catch((error) => {
        observeCaughtError(error, "adapters/cluster/kubernetes-api");
        combined.throwIfAborted();
        throw channelError ?? error;
      });
    return {
      statusCode: response.statusCode,
      chunks: response.body,
      destroy: () => response.body.destroy(),
    };
  }
  async function read(response: ApiResponse): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.chunks) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        response.destroy();
        throw new Error("Kubernetes response exceeded its size limit");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function check(response: ApiResponse, path: string) {
    if ((response.statusCode ?? 500) < 300) return;
    const raw = await read(response);
    let message = `Kubernetes API returned HTTP ${response.statusCode}`;
    try {
      message = JSON.parse(raw).message || message;
    } catch {}
    // Admission errors can quote a Secret's submitted data. Never return bodies.
    if (path.includes("/secrets"))
      message = `Kubernetes secret operation failed (HTTP ${response.statusCode})`;
    throw new KubernetesApiError(response.statusCode ?? 500, message.slice(0, 2000));
  }
  async function* lines(path: string, signal: AbortSignal) {
    const response = await open("GET", path, undefined, signal, true);
    await check(response, path);
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of response.chunks) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 2 * 1024 * 1024)
          throw new Error("Kubernetes stream record exceeded its size limit");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line) yield line;
        }
      }
      pending += decoder.decode();
      if (pending) yield pending;
    } finally {
      response.destroy();
    }
  }
  return {
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<T> {
      const response = await open(method, path, body, signal);
      await check(response, path);
      const raw = await read(response);
      return (raw ? JSON.parse(raw) : {}) as T;
    },
    async *watch(path, signal) {
      for await (const line of lines(path, signal)) yield JSON.parse(line);
    },
    logs: lines,
    async dispose() {
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (bridge.listening) bridge.close();
      await pool?.destroy();
    },
  };
}
