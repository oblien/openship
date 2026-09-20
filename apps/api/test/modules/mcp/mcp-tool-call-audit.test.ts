/**
 * Which tool calls get their own audit row.
 *
 * `source: "mcp"` told the log that an assistant acted, but only for the calls
 * something else already recorded — the secureRouter auto-emitter, which fires on
 * write/admin routes that returned 2xx/3xx. That left two holes, and they were the
 * ones an operator asks about after the fact:
 *
 *   - every READ an agent made (no row at all — read routes don't auto-emit)
 *   - every call it was REFUSED (the emitter skips non-2xx, so a denied write was
 *     indistinguishable from a call never made)
 *
 * The fix is one row per otherwise-unrecorded call, which puts the rule between two
 * failure modes worth pinning down: record everything and every mutation an agent
 * makes is logged twice, record nothing extra and reads go dark again.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const auditCreate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@repo/db", () => ({ repos: { auditEvent: { create: auditCreate } } }));

import { needsOwnAuditRow, recordToolCall } from "../../../src/modules/mcp/mcp-audit";
import type { ToolCallActor, ToolCallRecord } from "../../../src/modules/mcp/mcp-audit";

const ACTOR: ToolCallActor = {
  organizationId: "org1",
  userId: "u1",
  clientId: "oauth:cli_abc",
  tokenId: "pat_binding1",
  ipAddress: "203.0.113.7",
  userAgent: "claude-desktop/1.2",
};

function call(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    tool: "get_projects",
    method: "GET",
    path: "/api/projects",
    action: "list",
    status: 200,
    ok: true,
    ...over,
  };
}

/** The row handed to the repo, after the fire-and-forget write settles. */
async function rowFor(record: ToolCallRecord, actor: ToolCallActor = ACTOR) {
  recordToolCall(actor, record);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return auditCreate.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown> | undefined;
}

beforeEach(() => {
  auditCreate.mockClear();
});

describe("the rule: only calls nothing else records", () => {
  it("records reads and lists — the blind spot this exists for", () => {
    expect(needsOwnAuditRow({ ok: true, action: "read" })).toBe(true);
    expect(needsOwnAuditRow({ ok: true, action: "list" })).toBe(true);
  });

  it("stays out of the way of a successful write, which records itself", () => {
    // route-permission.ts's emitter already wrote a row naming the resource and
    // carrying the diff — a strictly better row than a tool-call row.
    expect(needsOwnAuditRow({ ok: true, action: "write" })).toBe(false);
    expect(needsOwnAuditRow({ ok: true, action: "admin" })).toBe(false);
  });

  it("records a write that FAILED — the emitter fires only on 2xx/3xx", () => {
    // An agent pushing at the edge of its scope, which is the case where the
    // absence of a row was worst.
    expect(needsOwnAuditRow({ ok: false, action: "write" })).toBe(true);
    expect(needsOwnAuditRow({ ok: false, action: "admin" })).toBe(true);
    expect(needsOwnAuditRow({ ok: false, action: "read" })).toBe(true);
  });

  it("records an unrecognized action rather than dropping it", () => {
    // A new permission verb must not silently create a fresh blind spot.
    expect(needsOwnAuditRow({ ok: true, action: "create" })).toBe(true);
    expect(needsOwnAuditRow({ ok: true, action: "" })).toBe(true);
  });
});

describe("the row", () => {
  it("is attributed to the agent, not just to 'an assistant'", async () => {
    const row = await rowFor(call());
    expect(row).toMatchObject({
      organizationId: "org1",
      actorUserId: "u1",
      eventType: "mcp.tool_called",
      resourceType: "mcp_client",
      resourceId: "pat_binding1",
      source: "mcp",
      sourceClientId: "oauth:cli_abc",
    });
  });

  it("carries the real client IP and user agent, not the loopback dispatch", async () => {
    // An in-process sub-request has no peer and no UA; both are read off the outer
    // request, which is the assistant's own.
    const row = await rowFor(call());
    expect(row).toMatchObject({ ipAddress: "203.0.113.7", userAgent: "claude-desktop/1.2" });
  });

  it("names the tool and the route it hit, with the status", async () => {
    const row = await rowFor(call({ tool: "delete_project", method: "DELETE", path: "/api/projects/:id", action: "admin", status: 403, ok: false }));
    expect(row?.after).toEqual({
      tool: "delete_project",
      route: "DELETE /api/projects/:id",
      status: 403,
      ok: false,
    });
  });

  it("stores the route TEMPLATE, so no resource id rides along in it", async () => {
    const row = await rowFor(call({ path: "/api/projects/:id/services/:serviceId" }));
    expect(String((row?.after as { route: string }).route)).toContain(":serviceId");
  });

  it("never carries the arguments", async () => {
    // Tool args routinely hold env values and secrets. The same reasoning keeps
    // grant tuples out of mcp.scope_changed.
    const row = await rowFor(call());
    expect(Object.keys(row?.after as object).sort()).toEqual(["ok", "route", "status", "tool"]);
  });

  it("is skipped when no org resolved — there is nothing to attribute it to", async () => {
    await rowFor(call(), { ...ACTOR, organizationId: null });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("writes nothing for a successful write", async () => {
    await rowFor(call({ method: "POST", action: "write", status: 201 }));
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
