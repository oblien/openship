import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { NodeHttpHandler, type NodeHttpHandlerOptions } from "@smithy/node-http-handler";
import { resolvePinnedHost, SsrfError } from "./outbound-target";

/** Smithy's streaming/retry transport, with the destination pinned before
 * connection. Agent lookup hooks alone are not honored by every Bun version.
 * Each original hostname keeps its own TLS identity and connection pool. */
export class PublicHttpHandler {
  readonly metadata = { handlerProtocol: "http/1.1" };
  private readonly handlers = new Map<string, NodeHttpHandler>();
  private readonly options: NodeHttpHandlerOptions = {};

  async handle(
    request: Parameters<NodeHttpHandler["handle"]>[0],
    options: Parameters<NodeHttpHandler["handle"]>[1] = {},
  ): ReturnType<NodeHttpHandler["handle"]> {
    if (request.protocol !== "https:" && request.protocol !== "http:") {
      throw new SsrfError("Only HTTP(S) backup endpoints are allowed");
    }
    const hostname = request.hostname.replace(/^\[|\]$/g, "");
    const signal =
      options.abortSignal instanceof AbortSignal
        ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000);
    const { ip } = await resolvePinnedHost(hostname, false, signal);
    signal.throwIfAborted();
    const origin = `${request.protocol}//${hostname}:${request.port ?? ""}`;
    let handler = this.handlers.get(origin);
    if (!handler) {
      handler = new NodeHttpHandler({
        ...this.options,
        httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 50 }),
        httpsAgent: new HttpsAgent({
          keepAlive: true,
          maxSockets: 50,
          servername: isIP(hostname) ? "" : hostname,
        }),
      });
      this.handlers.set(origin, handler);
    }
    // Keep the SDK's signed Host header, path, query and body unchanged. Only
    // the socket destination changes; the agent verifies the original TLS name.
    const pinned = request.clone();
    pinned.hostname = ip;
    return handler.handle(pinned, options);
  }

  destroy() {
    for (const handler of this.handlers.values()) handler.destroy();
    this.handlers.clear();
  }

  updateHttpClientConfig<K extends keyof NodeHttpHandlerOptions>(
    key: K,
    value: NodeHttpHandlerOptions[K],
  ) {
    this.options[key] = value;
    for (const handler of this.handlers.values()) handler.updateHttpClientConfig(key, value);
  }

  httpHandlerConfigs() {
    return { ...this.options };
  }
}
