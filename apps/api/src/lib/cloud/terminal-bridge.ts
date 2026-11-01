import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import WebSocket from "ws";
import type { WSContext, WSEvents } from "hono/ws";
import { AppError } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import { authorization } from "@repo/platform/engine/lib/authorization";
import { cloudRuntimeTarget, env } from "@repo/platform/engine/config/env";
import { resolveResourceAuthority } from "@repo/platform/engine/lib/cloud/resource-authority";
import { assertCloudProxyScope } from "@repo/platform/engine/lib/cloud/scope";
import { linkedCloudIdentity } from "@repo/platform/engine/lib/cloud/server-link";
import { cloudFetchAsOrgOwner, sameCloudIdentity, type CloudIdentity } from "@repo/platform/engine/lib/cloud/transport";

import { refreshTerminalContext } from "../terminal-authorization";

type TerminalKind = "server" | "service";
export interface CloudTerminalTicket {
  identity: CloudIdentity;
  token: string;
}
const PREFIX = "openship.terminal.v1+";
const RESUME_PREFIX = "openship.terminal.resume+";
const MAX_BUFFER = 1024 * 1024;
const active = new Map<string, number>();
const terminalPath = (kind: TerminalKind) => kind === "server" ? "/api/terminal" : "/api/services/terminal";

/** Mint upstream only after local account authorization. The browser receives
 * a local one-shot ticket; the Cloud ticket and credential stay server-side. */
export async function prepareCloudTerminal(ctx: ExecutionContext, kind: TerminalKind, id: string): Promise<CloudTerminalTicket | null> {
  if (await resolveResourceAuthority(kind, id, ctx.organizationId) !== "cloud") return null;
  assertCloudProxyScope(ctx);
  await authorization.authorize(ctx, { resourceType: kind, resourceId: id, action: "admin" });
  const identity = await linkedCloudIdentity(ctx.organizationId);
  const response = await cloudFetchAsOrgOwner(ctx.organizationId, `${terminalPath(kind)}/ticket`, {
    method: "POST", body: JSON.stringify({ [`${kind}Id`]: id }),
  }, identity);
  if (!response) throw new AppError("Openship Cloud is unreachable", 503, "CLOUD_UNREACHABLE");
  const body = await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/lib/cloud/terminal-bridge"); return null; }) as { token?: unknown; success?: unknown; error?: unknown; code?: unknown } | null;
  if (!response.ok) throw new AppError(typeof body?.error === "string" ? body.error : "Cloud terminal is unavailable", response.status,
    typeof body?.code === "string" ? body.code : "CLOUD_TERMINAL_UNAVAILABLE");
  if (body?.success !== true || typeof body.token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(body.token))
    throw new AppError("Cloud returned an invalid terminal ticket", 502, "INVALID_CLOUD_RESPONSE");
  return { identity, token: body.token };
}

/** Relay the existing terminal protocol. PTY ownership, admission, audit,
 * resume and idle limits remain in Cloud's normal terminal implementation. */
export function cloudTerminalHandlers(input: {
  kind: TerminalKind; id: string; context: ExecutionContext;
  cloud: CloudTerminalTicket; resumeToken: string;
}): WSEvents {
  let upstream: WebSocket | null = null;
  let client: WSContext | null = null;
  let closed = false;
  let counted = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Array<string | Uint8Array> = [];
  let pendingBytes = 0;
  const owner = `${input.context.organizationId}:${input.context.userId}:${input.kind}`;

  function close(code = 1000, reason = "", terminateShell = false) {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    pending = [];
    pendingBytes = 0;
    if (counted) {
      const remaining = (active.get(owner) ?? 1) - 1;
      if (remaining > 0) active.set(owner, remaining); else active.delete(owner);
      counted = false;
    }
    if (upstream?.readyState === WebSocket.OPEN) {
      if (terminateShell) upstream.send(JSON.stringify({ type: "close" }));
      upstream.close();
    } else if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
    try { client?.close(code, reason); } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/lib/cloud/terminal-bridge"); /* peer already closed */ }
  }
  function fail(message: string, code = 4500, terminateShell = false) {
    if (closed) return;
    try { client?.send(JSON.stringify({ type: "error", code: "server_error", message })); } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/lib/cloud/terminal-bridge"); /* disconnected */ }
    close(code, message, terminateShell);
  }
  async function stillAuthorized() {
    const current = await linkedCloudIdentity(input.context.organizationId);
    const ctx = await refreshTerminalContext(input.context);
    return sameCloudIdentity(current, input.cloud.identity) && await authorization.checkPermissionOnResource(ctx, {
      resourceType: input.kind, resourceId: input.id, action: "admin",
    });
  }
  return {
    async onOpen(_event, ws) {
      client = ws;
      try {
        if (!await stillAuthorized()) return fail("The Cloud connection changed. Reopen the terminal.", 4401);
        if (closed) return;
        if ((active.get(owner) ?? 0) >= env.TERMINAL_MAX_SESSIONS_PER_USER)
          return fail("Too many active terminals", 4429);
        active.set(owner, (active.get(owner) ?? 0) + 1);
        counted = true;
        const url = new URL(`${terminalPath(input.kind)}/ws/${encodeURIComponent(input.id)}`, input.cloud.identity.apiUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const protocols = [PREFIX + input.cloud.token];
        if (input.resumeToken) {
          if (!/^[A-Za-z0-9_-]{16,256}$/.test(input.resumeToken)) return fail("Invalid terminal resume token", 4401);
          protocols.push(RESUME_PREFIX + input.resumeToken);
        }
        upstream = new WebSocket(url, protocols, {
          headers: { Origin: new URL(cloudRuntimeTarget.dashboard).origin },
          followRedirects: false, handshakeTimeout: 15_000,
          maxPayload: MAX_BUFFER, perMessageDeflate: false,
        });
        upstream.on("error", (eventDiagnosticError) => { observeCaughtError(eventDiagnosticError, "api/lib/cloud/terminal-bridge"); return fail("Could not connect to the Cloud terminal"); });
        upstream.on("open", () => {
          if (closed) { upstream?.close(); return; }
          for (const data of pending) upstream!.send(data, { binary: typeof data !== "string" });
          pending = []; pendingBytes = 0;
        });
        upstream.on("message", (data, binary) => {
          if (closed) return;
          if (((client?.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0) > MAX_BUFFER)
            return fail("Terminal output exceeded the connection buffer");
          const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
          try { client?.send(binary ? new Uint8Array(bytes) : bytes.toString("utf8")); } catch (diagnosticFailure) {
            observeCaughtError(diagnosticFailure, "api/lib/cloud/terminal-bridge"); close(); }
        });
        upstream.on("close", code => close(code === 1000 || code === 1001 || (code >= 4000 && code <= 4999) ? code : 1011));
        // Revocation closes a live bridge too; a socket never outlives the
        // account/organization that authorized its one-shot ticket.
        timer = setInterval(() => {
          if (checking || closed) return;
          checking = true;
          void stillAuthorized().then(allowed => {
            if (!allowed) fail("The Cloud connection changed. Reopen the terminal.", 4401, true);
          }).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/lib/cloud/terminal-bridge"); return fail("Cloud terminal authorization expired", 4401, true); }).finally(() => { checking = false; });
        }, 5_000);
        timer.unref?.();
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "api/lib/cloud/terminal-bridge"); fail("Could not authorize the Cloud terminal", 4401); }
    },
    onMessage(event) {
      if (closed) return;
      const data = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const length = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (length > MAX_BUFFER || (upstream?.bufferedAmount ?? 0) > MAX_BUFFER)
        return fail("Terminal input exceeded the connection buffer");
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: typeof data !== "string" });
      else if (pending.length < 256 && pendingBytes + length <= MAX_BUFFER) { pending.push(data); pendingBytes += length; }
      else fail("Terminal input exceeded the connection buffer");
    },
    onClose() { close(); },
    onError() { close(); },
  };
}
