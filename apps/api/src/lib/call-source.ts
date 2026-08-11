/**
 * Where a request came in from — the value stamped on audit_event.source.
 *
 * The hard part is MCP. An MCP tool call doesn't arrive as its own kind of HTTP
 * request: mcp-dispatch re-enters the app through `app.fetch()` with the caller's
 * bearer token, precisely so routing, auth and permissions are not duplicated.
 * That means an MCP-driven write and a scripted PAT write are indistinguishable
 * at the middleware layer unless the dispatcher says which it is.
 *
 * A plain `x-openship-source: mcp` header would say it — and so could anyone with
 * curl, which matters because "what did the AI assistant do here" is a question
 * people will answer from this column. So the claim is signed with a nonce
 * generated at boot and never sent anywhere: only a request originating INSIDE
 * this process can know it. A forged header fails the check and the source is
 * derived from the credential instead.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getRequestContext } from "./request-context";

export const AUDIT_SOURCES = ["dashboard", "mcp", "cli", "api", "webhook", "system"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === "string" && (AUDIT_SOURCES as readonly string[]).includes(value);
}

const CALL_SOURCE_HEADER = "x-openship-call-source";

/**
 * Process-local secret. Regenerated on every boot: an in-flight forged header
 * from a previous process is worthless, and there is nothing to leak or rotate.
 */
const PROCESS_NONCE = randomBytes(16).toString("hex");

/** Headers an internal re-dispatch adds so its source survives the round trip. */
export function internalSourceHeader(source: AuditSource): Record<string, string> {
  return { [CALL_SOURCE_HEADER]: `${source}.${PROCESS_NONCE}` };
}

/** Constant-time, because the nonce is the whole gate: leak it and `mcp` is claimable. */
function nonceMatches(candidate: string): boolean {
  if (candidate.length !== PROCESS_NONCE.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(PROCESS_NONCE));
}

/** The claimed source, but only if the claim came from this process. */
function trustedClaim(c: Context): AuditSource | null {
  const raw = c.req.header(CALL_SOURCE_HEADER);
  if (!raw) return null;
  const sep = raw.lastIndexOf(".");
  if (sep <= 0) return null;
  const claimed = raw.slice(0, sep);
  if (!nonceMatches(raw.slice(sep + 1))) return null;
  return isAuditSource(claimed) ? claimed : null;
}

/**
 * Which surface this request came in through.
 *
 * Derivation, once the trusted claim is out of the way:
 *   cookie / zero-auth session → dashboard  (a browser, or a local single-user box)
 *   OAuth bearer               → mcp        (auth.ts resolves one through `getMcpSession`,
 *                                            so an OAuth principal IS an MCP session)
 *   PAT + an openship-cli UA   → cli
 *   any other bearer           → api
 *   no request context at all  → system
 *
 * The UA check is the one soft signal here; a caller who spoofs it gets labelled
 * "cli" instead of "api", which changes nothing anyone relies on. `mcp` and
 * `dashboard` are not reachable that way.
 */
export function resolveCallSource(c: Context): AuditSource {
  const claim = trustedClaim(c);
  const resolved = claim ?? derive(c);
  // Share the best answer with emitters that run outside the handler chain.
  const holder = ambient.getStore();
  if (holder) holder.value = resolved;
  return resolved;
}

function derive(c: Context): AuditSource {
  let ctx: ReturnType<typeof getRequestContext> | null = null;
  try {
    ctx = getRequestContext(c);
  } catch {
    return fromHeaders(c); // pre-auth, or a route that never builds a ctx
  }

  if (ctx.sessionKind === "cookie" || ctx.sessionKind === "zero-auth") return "dashboard";
  if (ctx.principalKind === "oauth") return "mcp";
  return isCliAgent(c) ? "cli" : "api";
}

function isCliAgent(c: Context): boolean {
  return (c.req.header("user-agent") ?? "").startsWith("openship-cli");
}

/**
 * Header-only derivation, for requests with no RequestContext to read.
 *
 * The UA is checked FIRST because the routes that land here are largely the
 * pre-auth ones (bootstrap, setup) — they carry no bearer token, so keying on
 * `authorization` alone would file every CLI-driven install under "dashboard".
 */
function fromHeaders(c: Context): AuditSource {
  if (isCliAgent(c)) return "cli";
  return c.req.header("authorization") ? "api" : "dashboard";
}

// ─── Ambient source, for emitters outside the handler chain ──────────────────
//
// Better Auth's organization hooks (member.*, invitation.*, organization.*) fire
// from inside the /api/auth/* handler, which deliberately bypasses our auth
// middleware — so there is no Hono context to read and those rows would all be
// sourceless. They are also the rows a security reviewer cares most about. The
// seed is header-derived (enough to separate a browser from a token) and gets
// upgraded in place the moment a handler calls resolveCallSource.

const ambient = new AsyncLocalStorage<{ value: AuditSource }>();

/** Seed the per-request ambient source. Call once, in a global middleware. */
export function runWithCallSource<T>(c: Context, fn: () => T): T {
  return ambient.run({ value: trustedClaim(c) ?? fromHeaders(c) }, fn);
}

/** The current request's source, or null outside a request (crons, boot). */
export function ambientCallSource(): AuditSource | null {
  return ambient.getStore()?.value ?? null;
}
