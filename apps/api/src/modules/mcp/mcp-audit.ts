/**
 * What an agent did, in the audit log.
 *
 * A dispatched tool call runs through the real HTTP stack, so a write/admin route
 * already emits its own audit row on success — the secureRouter auto-emitter in
 * route-permission.ts — now carrying `source: "mcp"` and the calling client. Two
 * kinds of call that emitter never covers are exactly the two that were missing:
 *
 *   - READS. A `read`/`list` route audits nothing, deliberately: for a human
 *     clicking around a dashboard, logging every page view is noise. For an
 *     autonomous agent it is the whole question — "what did it look at" had no
 *     answer at all.
 *   - FAILURES. The emitter fires only on 2xx/3xx, so a permission-denied write
 *     left no trace. An agent probing the edge of its scope was invisible
 *     precisely when someone would want to see it.
 *
 * Keeping the rule here, as one predicate, is what stops the two failure modes it
 * sits between: record everything and every mutation is logged twice; record
 * nothing extra and reads go dark again.
 */

import { audit } from "../../lib/audit";

/** One executed tool call — the facts the audit decision is made from. */
export interface ToolCallRecord {
  tool: string;
  method: string;
  /** Route path with :params — never the filled-in one, which carries ids. */
  path: string;
  /** The route's permission action ("read" | "list" | "write" | "admin" | …). */
  action: string;
  status: number;
  ok: boolean;
}

/** Who made the call, resolved once per MCP request by the route. */
export interface ToolCallActor {
  /** Null → no org resolved; there is nothing to attribute a row to. */
  organizationId: string | null;
  userId: string;
  /** Canonical principal id — `oauth:<clientId>` / `pat:<tokenId>`. */
  clientId: string;
  /** The personal_access_token row behind this caller (the audit row's resource). */
  tokenId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * True when this call would otherwise leave no trace. A successful write already
 * recorded itself as the change it made, which is a better row than a tool-call
 * row: it names the resource and carries the diff.
 */
export function needsOwnAuditRow(record: Pick<ToolCallRecord, "ok" | "action">): boolean {
  const selfAuditing = record.action === "write" || record.action === "admin";
  return !(record.ok && selfAuditing);
}

/**
 * Record a tool call, if it needs recording.
 *
 * The row carries the tool name, the route it hit and the status. NOT the
 * arguments: they are unbounded and routinely hold env values and secrets, and
 * the same reasoning already keeps grant tuples out of `mcp.scope_changed`.
 */
export function recordToolCall(actor: ToolCallActor, record: ToolCallRecord): void {
  if (!actor.organizationId) return;
  if (!needsOwnAuditRow(record)) return;

  audit.recordAsync(
    {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      // Stated, not derived: `resolveCallSource` reads the credential, and a
      // PAT-backed MCP client resolves to "api"/"cli" on the outer request. This
      // request IS the MCP endpoint — there is nothing to infer.
      source: "mcp",
      sourceClientId: actor.clientId,
    },
    {
      eventType: "mcp.tool_called",
      resourceType: "mcp_client",
      resourceId: actor.tokenId,
      after: {
        tool: record.tool,
        route: `${record.method} ${record.path}`,
        status: record.status,
        ok: record.ok,
      },
    },
  );
}
