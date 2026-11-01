import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { Context } from "hono";
import WebSocket from "ws";
import { instanceOrigin, INVITATION_DELIVERY_HEADER } from "@repo/core";
import { env, trustedOrigins } from "@repo/platform/engine/config/env";
import { zeroAuthAllowed } from "../../../middleware/zero-auth-guard";
import { upgradeWebSocket } from "../../../lib/ws";
import { controllerConnection, type ControllerState } from "./controller-state";
import { remoteSessionHeaders, saveRemoteCookies } from "./relay-session";

const relays = new Set<AbortController>();
export function closeInstanceRelays(): void {
  for (const relay of relays) relay.abort();
  relays.clear();
}

/** The trusted local UI never navigates to remote HTML. Only API traffic leaves
 * this loopback bridge, authenticated as the paired user (never INTERNAL_TOKEN).
 * A failed remote request stays failed: there is no local database fallback. */
export async function relayInstanceRequest(c: Context, state: ControllerState): Promise<Response> {
  if (env.DEPLOY_MODE !== "desktop" || !(await zeroAuthAllowed(c)).ok)
    return c.json({ error: "Desktop connection required." }, 403);
  const connection = controllerConnection(state);
  if (!connection) return c.json({ error: "Reconnect to the active instance." }, 503);
  const origin = instanceOrigin(connection.origin);
  const path = new URL(c.req.url);
  if (path.pathname === "/api/auth/desktop-login")
    return c.redirect(env.OPENSHIP_LOCAL_DASHBOARD_URL!);
  if (!path.pathname.startsWith("/api/")) return c.notFound();
  const target = new URL(`${origin}${path.pathname}${path.search}`);
  const headers = remoteSessionHeaders(connection);
  for (const name of [
    "accept",
    "content-type",
    INVITATION_DELIVERY_HEADER,
    "x-organization-id",
    "last-event-id",
    "range",
    "if-none-match",
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  // Better Auth requires its canonical Origin for cookie login/2FA. It is set
  // by this fixed-peer bridge after the local origin guard, never forwarded
  // from an arbitrary caller.
  headers.set("origin", new URL(origin).origin);
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    const requestOrigin = c.req.header("origin");
    if (requestOrigin && !trustedOrigins.includes(requestOrigin))
      return c.json({ error: "Origin not allowed", code: "ORIGIN_REJECTED" }, 403);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const protocols = (c.req.header("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const remote = new WebSocket(target, protocols, {
      headers: Object.fromEntries(headers),
      followRedirects: false,
      handshakeTimeout: 15_000,
      maxPayload: 2 * 1024 * 1024,
    });
    const backlog: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    const outgoing: Array<string | ArrayBuffer | Blob> = [];
    let bufferedBytes = 0;
    let local:
      | {
          send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
          close(code?: number, reason?: string): void;
        }
      | undefined;
    remote.on("message", (data, binary) => {
      if (local) local.send(binary ? Buffer.from(data as Buffer) : data.toString());
      else if (
        backlog.length < 64 &&
        (bufferedBytes += Buffer.byteLength(data.toString())) <= 2 * 1024 * 1024
      )
        backlog.push({ data, binary });
      else remote.close(1009, "Receiver is not ready");
    });
    remote.on("open", () => {
      for (const data of outgoing) remote.send(data);
      outgoing.length = 0;
    });
    remote.on("error", (eventDiagnosticError) => { observeCaughtError(eventDiagnosticError, "api/modules/system/instance/desktop-relay"); return local?.close(1011, "Remote instance is unavailable"); });
    remote.on("close", (code) =>
      local?.close([1000, 1001, 1008, 1009, 1011].includes(code) ? code : 1011),
    );
    const response = await upgradeWebSocket(() => ({
      onOpen: (_event, ws) => {
        local = ws;
        for (const entry of backlog)
          ws.send(entry.binary ? Buffer.from(entry.data as Buffer) : entry.data.toString());
        backlog.length = 0;
        bufferedBytes = 0;
        if (remote.readyState === WebSocket.CLOSED)
          ws.close(1011, "Remote instance is unavailable");
      },
      onMessage: (event) => {
        if (remote.bufferedAmount > 2 * 1024 * 1024) {
          local?.close(1013, "Remote connection is busy");
          return;
        }
        if (remote.readyState === WebSocket.OPEN) remote.send(event.data);
        else if (
          remote.readyState === WebSocket.CONNECTING &&
          outgoing.length < 32 &&
          (bufferedBytes +=
            typeof event.data === "string"
              ? Buffer.byteLength(event.data)
              : event.data instanceof Blob
                ? event.data.size
                : event.data.byteLength) <=
            2 * 1024 * 1024
        )
          outgoing.push(event.data);
        else local?.close(1013, "Remote connection is not ready");
      },
      onClose: () => {
        remote.close();
      },
      onError: () => {
        remote.terminate();
      },
    }))(c, async () => {});
    if (!response) throw new Error("The remote WebSocket could not be upgraded.");
    return response;
  }
  const relay = new AbortController();
  relays.add(relay);
  // Bound connection/response-header waits, but keep live SSE streams open.
  const timeout = setTimeout(() => relay.abort(), 60_000);
  const finish = () => {
    clearTimeout(timeout);
    relays.delete(relay);
  };
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: c.req.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.any([c.req.raw.signal, relay.signal]),
    };
    if (!["GET", "HEAD"].includes(c.req.method)) {
      init.body = c.req.raw.body;
      init.duplex = "half";
    }
    const requestId = c.get("diagnosticRequestId");
    if (requestId) headers.set("X-Request-ID", requestId);
    const response = await fetch(target, init);
    clearTimeout(timeout);
    await saveRemoteCookies(state, response.headers);
    const outgoing = new Headers(response.headers);
    // Sessions live in the bridge; remote cookies must not overwrite local
    // Desktop cookies or leak a token to an unrelated domain.
    outgoing.delete("set-cookie");
    outgoing.delete("set-auth-token");
    outgoing.delete("content-encoding");
    outgoing.delete("content-length");
    for (const name of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      "trailer",
    ])
      outgoing.delete(name);
    outgoing.set("Cache-Control", "no-store");
    const reader = response.body?.getReader();
    if (!reader) {
      finish();
      return new Response(null, { status: response.status, headers: outgoing });
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            stream.close();
          } else stream.enqueue(chunk.value);
        } catch (error) {
          observeCaughtError(error, "api/modules/system/instance/desktop-relay");
          finish();
          stream.error(error);
        }
      },
      async cancel() {
        relay.abort();
        finish();
        await reader.cancel().catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "api/modules/system/instance/desktop-relay");
        });
      },
    });
    return new Response(body, { status: response.status, headers: outgoing });
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "api/modules/system/instance/desktop-relay");
    finish();
    return c.json(
      {
        error:
          "Your remote instance is unavailable. Reconnect when it is back online; your apps continue on their servers.",
        code: "REMOTE_INSTANCE_UNAVAILABLE",
      },
      503,
    );
  }
}
