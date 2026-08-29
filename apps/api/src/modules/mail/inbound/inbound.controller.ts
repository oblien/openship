/**
 * Inbound-rule CRUD for the mail admin panel.
 *
 * Every handler repeats the same three-part guard the ~30 existing mail handlers use, and
 * that repetition is load-bearing rather than copy-paste:
 *
 *   assertNotCloud        — the mail engine is self-hosted only.
 *   permission.assert     — with the CONCRETE serverId, never the wildcard. `mail_server`
 *                           is a CONDITIONAL_SINGLETON: on a route with no `:serverId`
 *                           PATH param the tag degrades to resourceId "*", which for
 *                           owner/admin/member is a pure role×type decision naming no
 *                           server — i.e. no tenant boundary at all. That is why serverId
 *                           is in the path here and not in the body.
 *   isServerInOrg         — ties the request to THIS org's server.
 *
 * Arming happens on write, and the engine is the source of truth for what is armed; there
 * is no mirror table. A failed arm leaves the rule row disabled with the reason attached
 * rather than a rule that looks live and captures nothing.
 */

import type { Context } from "hono";
import { safeErrorMessage } from "@repo/core";
import { repos, type MailInboundScope } from "@repo/db";
import { getRequestContext } from "../../../lib/request-context";
import { permission } from "../../../lib/permission";
import { param, isServerInOrg, assertNotCloud } from "../../../lib/controller-helpers";
import {
  armDomain,
  disarmDomain,
  ForeignBccError,
  listEngineDomains,
  ruleDomain,
} from "./capture";
import { runInboundForServer } from "./read";

const SCOPES: readonly MailInboundScope[] = ["mailbox", "domain", "all"];
const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function errorJson(c: Context, err: unknown) {
  if (err instanceof ForeignBccError) {
    return c.json({ error: err.message, code: "MAIL_FOREIGN_BCC" }, 409);
  }
  return c.json({ error: safeErrorMessage(err) }, 500);
}

/**
 * Guard shared by every handler below. Returns a Response to short-circuit, or the
 * resolved context to continue with.
 */
async function guardServer(c: Context, action: "read" | "write") {
  const cloud = assertNotCloud(c);
  if (cloud) return { response: cloud } as const;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action,
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return { response: c.json({ error: "Server not found" }, 404) } as const;
  }
  return { serverId, organizationId: ctx.organizationId! } as const;
}

/**
 * Validate the scope/target pair at the WRITE boundary.
 *
 * This is the enforcement the schema deliberately does not carry as a CHECK constraint:
 * a mailbox or domain rule with no target would be representable, and if the filter ever
 * read a missing target as "no constraint" it would silently widen to every message on the
 * server. The filter already fails closed; this refuses to store the row in the first
 * place, so the operator finds out at save time instead of never.
 */
function validateScope(scope: string, target: unknown): { scope: MailInboundScope; target: string | null } {
  if (!SCOPES.includes(scope as MailInboundScope)) {
    throw new Error(`Unknown scope "${scope}". Expected one of: ${SCOPES.join(", ")}.`);
  }
  const s = scope as MailInboundScope;
  if (s === "all") return { scope: s, target: null };

  const t = typeof target === "string" ? target.trim().toLowerCase() : "";
  if (!t) throw new Error(`A ${s} rule needs a target.`);
  if (s === "mailbox" && !EMAIL_RE.test(t)) {
    throw new Error(`"${t}" is not a valid email address.`);
  }
  if (s === "domain" && !DOMAIN_RE.test(t)) {
    throw new Error(`"${t}" is not a valid domain.`);
  }
  return { scope: s, target: t };
}

/**
 * The domains a rule needs armed on the engine.
 *
 * The scope→domain derivation itself lives in `ruleDomain` (capture.ts) so the write path
 * and the read job cannot disagree about which domain a target names. Only the `all`
 * fan-out differs here: the write path has to arm every domain the engine currently has,
 * whereas the read job walks whatever is actually armed.
 */
async function domainsFor(
  serverId: string,
  scope: MailInboundScope,
  target: string | null,
): Promise<string[]> {
  if (scope === "all") return listEngineDomains(serverId);
  const domain = ruleDomain({ scope, target });
  return domain ? [domain] : [];
}

/**
 * Release the BCC on any candidate domain no enabled rule still wants.
 *
 * This has to run on EVERY mutation that can narrow what is watched, not just delete
 * (GH-559). An armed domain keeps Postfix BCC'ing a full second copy of every message
 * into a collector mailbox provisioned at QUOTA 0, and the only thing that prunes those
 * copies is the read job visiting that domain. Disable a rule — or move its scope — and
 * the copies keep arriving while nothing deletes them, on /var/vmail, a bind mount with
 * no quota of its own. That fills the disk and takes the mail server down.
 *
 * Capture is domain-keyed and SHARED, so a domain a second rule still covers must stay
 * armed; `candidates` is therefore only what the mutation could have orphaned, never the
 * whole engine. Failures are swallowed because `reconcileDomains` repairs the residue on
 * a schedule — a disarm that loses a race must not fail the operator's save.
 */
async function releaseOrphanedDomains(serverId: string, candidates: string[]): Promise<void> {
  if (candidates.length === 0) return;
  const remaining = await repos.mailInbound.listEnabledByServer(serverId);
  const stillWanted = new Set<string>();
  for (const r of remaining) {
    for (const d of await domainsFor(serverId, r.scope as MailInboundScope, r.target)) {
      stillWanted.add(d);
    }
  }
  for (const d of candidates) {
    if (!stillWanted.has(d)) await disarmDomain(serverId, d).catch(() => undefined);
  }
}

export async function listRulesHandler(c: Context) {
  const g = await guardServer(c, "read");
  if ("response" in g) return g.response;
  try {
    const rules = await repos.mailInbound.listByServer(g.serverId);
    return c.json({ rules });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function createRuleHandler(c: Context) {
  const g = await guardServer(c, "write");
  if ("response" in g) return g.response;

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let scope: MailInboundScope;
  let target: string | null;
  try {
    ({ scope, target } = validateScope(String(body.scope ?? ""), body.target));
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }

  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "A rule needs a name." }, 400);

  const channelIds = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  if (channelIds.length === 0) {
    return c.json({ error: "Pick at least one notification channel." }, 400);
  }

  try {
    // Arm FIRST. A rule row that exists while capture is off is a rule that looks live and
    // silently sees nothing — the worse of the two half-states, and the one an operator
    // cannot diagnose from the UI.
    const domains = await domainsFor(g.serverId, scope, target);
    for (const d of domains) await armDomain(g.serverId, d);

    const rule = await repos.mailInbound.create({
      serverId: g.serverId,
      organizationId: g.organizationId,
      name,
      scope,
      target,
      fromPattern: typeof body.fromPattern === "string" ? body.fromPattern.trim() || null : null,
      subjectPattern:
        typeof body.subjectPattern === "string" ? body.subjectPattern.trim() || null : null,
      maxSpamScore: typeof body.maxSpamScore === "number" ? body.maxSpamScore : null,
      channelIds,
      enabled: body.enabled === false ? false : true,
    });
    return c.json({ rule }, 201);
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function updateRuleHandler(c: Context) {
  const g = await guardServer(c, "write");
  if ("response" in g) return g.response;
  const ruleId = param(c, "ruleId");

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const existing = await repos.mailInbound.findById(g.organizationId, ruleId);
    if (!existing) return c.json({ error: "Rule not found" }, 404);

    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (Array.isArray(body.channelIds)) patch.channelIds = body.channelIds.map(String);
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if ("fromPattern" in body) {
      patch.fromPattern = typeof body.fromPattern === "string" ? body.fromPattern.trim() || null : null;
    }
    if ("subjectPattern" in body) {
      patch.subjectPattern =
        typeof body.subjectPattern === "string" ? body.subjectPattern.trim() || null : null;
    }
    if ("maxSpamScore" in body) {
      patch.maxSpamScore = typeof body.maxSpamScore === "number" ? body.maxSpamScore : null;
    }
    // Clearing the pause is an explicit act, so resuming re-arms below.
    if (body.pausedReason === null) patch.pausedReason = null;

    if (typeof body.scope === "string") {
      const v = validateScope(body.scope, body.target ?? existing.target);
      patch.scope = v.scope;
      patch.target = v.target;
    }

    // What this rule covered BEFORE the write - the set that may now be orphaned. Read
    // first, because after the update the old scope is unrecoverable.
    const previouslyCovered = await domainsFor(
      g.serverId,
      existing.scope as MailInboundScope,
      existing.target,
    );

    const rule = await repos.mailInbound.update(g.organizationId, ruleId, patch as never);
    // The row can vanish between the findById above and here (a concurrent delete). That
    // delete already released its own domains, so there is nothing to arm and nothing to
    // orphan - just report it honestly rather than arming for a rule that no longer exists.
    if (!rule) return c.json({ error: "Rule not found" }, 404);

    // Arm from the PERSISTED row, so re-enabling a rule arms it again — the old code only
    // armed inside the scope branch, so flipping `enabled` back to true left a live rule
    // watching nothing. Unguarded on purpose: a failed arm is the operator's problem to
    // see now, and the file header's atomicity gap is what reconcileDomains repairs.
    if (rule.enabled) {
      for (const d of await domainsFor(g.serverId, rule.scope as MailInboundScope, rule.target)) {
        await armDomain(g.serverId, d);
      }
    }
    // Then release whatever this rule no longer wants: `enabled: false`, a narrowed scope,
    // or a retargeted domain (GH-559).
    await releaseOrphanedDomains(g.serverId, previouslyCovered);

    return c.json({ rule });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function deleteRuleHandler(c: Context) {
  const g = await guardServer(c, "write");
  if ("response" in g) return g.response;
  const ruleId = param(c, "ruleId");

  try {
    const existing = await repos.mailInbound.findById(g.organizationId, ruleId);
    if (!existing) return c.json({ error: "Rule not found" }, 404);

    // Read what it covered before the row is gone.
    const covered = await domainsFor(
      g.serverId,
      existing.scope as MailInboundScope,
      existing.target,
    );
    await repos.mailInbound.remove(g.organizationId, ruleId);
    await releaseOrphanedDomains(g.serverId, covered);
    return c.json({ ok: true });
  } catch (err) {
    return errorJson(c, err);
  }
}

/**
 * Run the read once, without dispatching or deleting — the "why did my rule not fire?"
 * button. `mail_server:write` rather than `:read` because the boot scanner rejects a POST
 * on a read-tagged route as a CRITICAL error and exits the process.
 */
export async function testRulesHandler(c: Context) {
  const g = await guardServer(c, "write");
  if ("response" in g) return g.response;
  try {
    const result = await runInboundForServer({
      serverId: g.serverId,
      organizationId: g.organizationId,
      dryRun: true,
    });
    return c.json(result);
  } catch (err) {
    return errorJson(c, err);
  }
}
