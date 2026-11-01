import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { net } from "electron";
import { Readable } from "node:stream";
import { isAllowedUpdateAssetUrl } from "./security";

/** Electron's fetch cancels manual redirects instead of returning a 3xx
 * response. Its request API lets us validate and follow each hop synchronously,
 * while retaining Chromium's proxy support and streaming backpressure. */
export async function fetchUpdateAsset(url: string, signal: AbortSignal): Promise<Response> {
  if (!isAllowedUpdateAssetUrl(url)) throw new Error("Untrusted update download destination.");
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "manual" });
    let redirects = 0;
    let incoming: Readable | undefined;
    const stop = (error: Error) => {
      cleanup();
      reject(error);
      incoming?.destroy(error);
      request.abort();
    };
    const abort = () => stop(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", error => { cleanup(); reject(error); });
    request.on("redirect", (_status, _method, destination) => {
      if (!isAllowedUpdateAssetUrl(destination)) {
        stop(new Error("Untrusted update download destination."));
      } else if (++redirects > 5) {
        stop(new Error("Too many update redirects."));
      } else {
        // Electron requires this during the redirect callback, before it returns.
        request.followRedirect();
      }
    });
    request.once("response", response => {
      // Electron's IncomingMessage extends Readable at runtime; its published
      // declaration only exposes the EventEmitter methods.
      incoming = response as unknown as Readable;
      incoming.once("error", error => { cleanup(); reject(error); });
      incoming.once("end", cleanup);
      incoming.once("close", () => { cleanup(); request.abort(); });
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const empty = [204, 205, 304].includes(response.statusCode);
        const body = empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (empty) incoming.resume();
        resolve(new Response(body, { status: response.statusCode, headers }));
      } catch (error) {
        observeCaughtError(error, "desktop/main/update-download");
        stop(error as Error);
      }
    });
    request.setHeader("User-Agent", "Openship-Desktop");
    request.end();
  });
}
