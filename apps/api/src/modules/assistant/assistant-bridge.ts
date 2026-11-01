import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

/** Transport adapter only: no tool catalog, dispatch, authorization or audit implementation here. */
export async function createAssistantBridge(options: {
  signal: AbortSignal;
  forward: (body: string) => Promise<Response>;
}) {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      request.headers.origin !== undefined
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (options.signal.aborted) {
      response.writeHead(410).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      options.signal.throwIfAborted();
      const result = await options.forward(Buffer.concat(chunks).toString("utf8"));
      options.signal.throwIfAborted();
      response.writeHead(result.status, {
        "Content-Type": result.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });
      response.end(await result.text());
    } catch {
      // Never serialize a native credential, request or transport exception.
      response
        .writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Assistant access is no longer available." }));
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", close);
    server.closeAllConnections();
    server.close();
  };
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) {
    close();
    options.signal.throwIfAborted();
  }
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token, close };
}
