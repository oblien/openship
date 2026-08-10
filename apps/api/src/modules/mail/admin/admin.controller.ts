/**
 * HTTP handlers for the mail admin panel.
 *
 * Thin layer over the service files in this folder - validates input,
 * extracts path / query params, calls the service, maps known errors to
 * 4xx responses. No business logic lives here.
 *
 * All routes are mounted under `/api/mail/admin/:serverId/…` in
 * `../mail.routes.ts` behind `localOnly` + `authMiddleware`.
 */

import type { Context } from "hono";
import { env } from "../../../config";
import { repos } from "@repo/db";
import { getRequestContext, type RequestContext } from "../../../lib/request-context";
import { permission } from "../../../lib/permission";
import { param, isServerInOrg, assertNotCloud } from "../../../lib/controller-helpers";
import {
  countDomainDependents,
  createDomain,
  deleteDomain,
  DomainExistsError,
  DomainHasDependentsError,
  DomainNotFoundError,
  getDomain,
  listDomains,
  updateDomain,
  validateDomain,
} from "./domains.service";
import {
  createMailbox,
  hardDeleteMailbox,
  getMailbox,
  listMailboxes,
  MailboxExistsError,
  MailboxNotFoundError,
  softDeleteMailbox,
  updateMailbox,
} from "./mailboxes.service";
import {
  createAlias,
  deleteAlias,
  listAliases,
  updateAliasActive,
  AliasConflictsWithMailboxError,
  AliasExistsError,
  AliasNotFoundError,
} from "./aliases.service";
import { getMailServerStats } from "./stats.service";
import { scanDns } from "./dns-scan.service";
import { sendTestEmail, TestEmailError } from "./test-email.service";
import { AppError, safeErrorMessage } from "@repo/core";
import { handleApiError } from "../../../middleware/error-handler";
import {
  getComponentLogs,
  restartAllComponents,
  runComponentAction,
  UnknownComponentError,
  type ComponentAction,
} from "./components.service";
import {
  acknowledgeDomainDns,
  getDomainDnsState,
  listPendingDomainDns,
} from "./domain-dns.service";
import {
  configureOutboundRelay,
  disableOutboundRelay,
  getOutboundRelay,
  type ConfigureRelayInput,
} from "./outbound-relay.service";
import { sshManager } from "../../../lib/ssh-manager";
import { decrypt } from "../../../lib/encryption";
import { readState } from "../mail-state";

/**
 * Org-scoped guard: confirms the path's :serverId belongs to the caller's
 * active organization. Returns true on success; returns false on failure
 * — handlers wrap false into a 404. Both unknown and out-of-org server
 * ids 404 indistinguishably to prevent cross-tenant existence leaks.
 *
 * Every admin handler (domains, mailboxes, components, dns, stats, etc.)
 * must call this — they all reach the iRedMail psql/SSH layer via the
 * named serverId, so an unguarded handler is a full mail-admin takeover.
 */
// ─── Domains ─────────────────────────────────────────────────────────────────

export async function listDomainsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    const rows = await listDomains(serverId);
    return c.json({ domains: rows });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function getDomainHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    const row = await getDomain(serverId, domain);
    if (!row) return c.json({ error: "Domain not found" }, 404);
    return c.json({ domain: row });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function createDomainHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const { row, dnsWarning } = await createDomain(serverId, {
      domain: String(body.domain ?? ""),
      description: body.description ? String(body.description) : undefined,
      maxMailboxes: body.maxMailboxes != null ? Number(body.maxMailboxes) : undefined,
      maxAliases: body.maxAliases != null ? Number(body.maxAliases) : undefined,
      defaultQuotaMB: body.defaultQuotaMB != null ? Number(body.defaultQuotaMB) : undefined,
    });
    return c.json({ domain: row, dnsWarning }, 201);
  } catch (err) {
    if (err instanceof DomainExistsError) {
      return c.json({ error: err.message }, 409);
    }
    return errorJson(c, err);
  }
}

export async function updateDomainHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await updateDomain(serverId, domain, {
      description: body.description != null ? String(body.description) : undefined,
      maxMailboxes: body.maxMailboxes != null ? Number(body.maxMailboxes) : undefined,
      maxAliases: body.maxAliases != null ? Number(body.maxAliases) : undefined,
      defaultQuotaMB: body.defaultQuotaMB != null ? Number(body.defaultQuotaMB) : undefined,
      active: body.active != null ? Boolean(body.active) : undefined,
    });
    return c.json({ domain: row });
  } catch (err) {
    if (err instanceof DomainNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

export async function deleteDomainHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  const cascade = c.req.query("cascade") === "true";
  try {
    await deleteDomain(serverId, domain, { cascade });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof DomainHasDependentsError) {
      return c.json(
        { error: err.message, dependents: err.dependents },
        409,
      );
    }
    return errorJson(c, err);
  }
}

// ─── Per-domain DNS (additional domains) ─────────────────────────────────────

/**
 * GET the DNS state for one domain. Returns 404 when no DNS records have
 * been generated for it (which is the case for the primary install
 * domain - its records live under /mail/status as the install-time
 * `dnsRecords`, not here).
 */
export async function getDomainDnsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    const state = await getDomainDnsState(serverId, domain.toLowerCase());
    if (!state) {
      return c.json({ error: "No DNS state for this domain" }, 404);
    }
    return c.json({ domain: domain.toLowerCase(), ...state });
  } catch (err) {
    return errorJson(c, err);
  }
}

/**
 * POST acknowledgement: operator confirmed they published the records.
 * Flips `acknowledgedAt` to now; the Domains tab stops rendering the
 * banner for this domain on the next reload.
 */
export async function acknowledgeDomainDnsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    await acknowledgeDomainDns(serverId, domain.toLowerCase());
    return c.json({ ok: true });
  } catch (err) {
    return errorJson(c, err);
  }
}

/**
 * GET every additional domain whose DNS publication is still pending
 * (acknowledgedAt == null). Lets the Domains tab render a stack of
 * banners in one round-trip instead of per-row.
 */
export async function pendingDomainDnsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    const pending = await listPendingDomainDns(serverId);
    // Flatten { domain, state } → { domain, ...state } so the shape matches
    // the dashboard's `AdditionalDomainDnsState` type.
    return c.json({
      pending: pending.map(({ domain, state }) => ({ domain, ...state })),
    });
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Outbound relay (split delivery: self-host inbox + SES/SMTP send) ─────────

/** GET the current outbound relay config (masked — never returns the password). */
export async function getOutboundRelayHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    const relay = await sshManager.withExecutor(serverId, (exec) => getOutboundRelay(exec));
    return c.json({ relay });
  } catch (err) {
    return errorJson(c, err);
  }
}

/**
 * Enable / update the outbound relay. Mutates Postfix on the mail server, so
 * it's gated at "admin". A blank password on update keeps the stored one
 * (mirrors the instance-SMTP "leave blank to keep" convention).
 */
export async function putOutboundRelayHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const provider = body.provider === "custom" ? "custom" : "ses";

  // Resolve the effective plaintext password: use the submitted one, else fall
  // back to the stored (encrypted) one so "change region only" doesn't require
  // re-typing the SMTP password.
  let password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    try {
      const state = await sshManager.withExecutor(serverId, (exec) => readState(exec));
      const enc = state?.outboundRelay?.passwordEncrypted;
      if (enc) password = decrypt(enc);
    } catch {
      /* fall through to the required-password error below */
    }
    if (!password) {
      return c.json({ error: "Relay password is required." }, 400);
    }
  }

  // Parse a list of {name,value} DKIM CNAME pairs from untrusted JSON.
  const parseDkim = (v: unknown): { name: string; value: string }[] | undefined =>
    Array.isArray(v)
      ? (v as unknown[])
          .filter((r): r is { name: string; value: string } =>
            !!r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string" && typeof (r as { value?: unknown }).value === "string")
          .map((r) => ({ name: r.name, value: r.value }))
      : undefined;

  // Per-additional-domain SES identities: { "y.com": { mailFromDomain?, sesDkim? } }.
  let identities: ConfigureRelayInput["identities"];
  if (body.identities && typeof body.identities === "object" && !Array.isArray(body.identities)) {
    identities = {};
    for (const [dom, raw] of Object.entries(body.identities as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as { mailFromDomain?: unknown; sesDkim?: unknown };
      identities[dom] = {
        mailFromDomain: typeof r.mailFromDomain === "string" && r.mailFromDomain ? r.mailFromDomain : undefined,
        sesDkim: parseDkim(r.sesDkim),
      };
    }
  }

  const input: ConfigureRelayInput = {
    provider,
    scope: body.scope === "selected" ? "selected" : "all",
    domains: Array.isArray(body.domains)
      ? (body.domains as unknown[]).filter((d): d is string => typeof d === "string")
      : undefined,
    region: typeof body.region === "string" ? body.region : undefined,
    host: typeof body.host === "string" ? body.host : undefined,
    port: Number(body.port),
    username: typeof body.username === "string" ? body.username : "",
    password,
    mailFromDomain: typeof body.mailFromDomain === "string" && body.mailFromDomain ? body.mailFromDomain : undefined,
    sesDkim: parseDkim(body.sesDkim),
    identities,
  };

  try {
    await sshManager.withExecutor(serverId, (exec) => configureOutboundRelay(exec, input));
    const relay = await sshManager.withExecutor(serverId, (exec) => getOutboundRelay(exec));
    return c.json({ relay });
  } catch (err) {
    return errorJson(c, err);
  }
}

/** Disable the outbound relay — revert Postfix to direct-to-MX. */
export async function deleteOutboundRelayHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    await sshManager.withExecutor(serverId, (exec) => disableOutboundRelay(exec));
    return c.json({ ok: true });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function domainDependentsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    validateDomain(domain);
    const deps = await countDomainDependents(serverId, domain);
    return c.json(deps);
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Mailboxes ───────────────────────────────────────────────────────────────

export async function listMailboxesHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param required" }, 400);
  try {
    const rows = await listMailboxes(serverId, domain);
    return c.json({ mailboxes: rows });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function getMailboxHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const email = c.req.param("email");
  if (!email) return c.json({ error: "email required" }, 400);
  try {
    const row = await getMailbox(serverId, email);
    if (!row) return c.json({ error: "Mailbox not found" }, 404);
    return c.json({ mailbox: row });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function createMailboxHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await createMailbox(serverId, {
      localPart: String(body.localPart ?? ""),
      domain: String(body.domain ?? ""),
      password: String(body.password ?? ""),
      name: body.name ? String(body.name) : undefined,
      quotaMB: body.quotaMB != null ? Number(body.quotaMB) : undefined,
    });
    return c.json({ mailbox: row }, 201);
  } catch (err) {
    if (err instanceof MailboxExistsError) {
      return c.json({ error: err.message }, 409);
    }
    return errorJson(c, err);
  }
}

export async function updateMailboxHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const email = c.req.param("email");
  if (!email) return c.json({ error: "email required" }, 400);
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await updateMailbox(serverId, email, {
      name: body.name != null ? String(body.name) : undefined,
      password: body.password ? String(body.password) : undefined,
      quotaMB: body.quotaMB != null ? Number(body.quotaMB) : undefined,
      active: body.active != null ? Boolean(body.active) : undefined,
    });
    return c.json({ mailbox: row });
  } catch (err) {
    if (err instanceof MailboxNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

export async function deleteMailboxHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const email = c.req.param("email");
  if (!email) return c.json({ error: "email required" }, 400);
  const hard = c.req.query("hard") === "true";

  try {
    if (hard) {
      await hardDeleteMailbox(serverId, email);
    } else {
      await softDeleteMailbox(serverId, email, (ctx.user.email || ctx.user.name || ctx.userId || "unknown"));
    }
    return c.json({ ok: true, mode: hard ? "hard" : "soft" });
  } catch (err) {
    if (err instanceof MailboxNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

// ─── Admin panel - aliases / forwards / catch-all ────────────────────────────

export async function listAliasesHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param required" }, 400);
  try {
    const rows = await listAliases(serverId, domain);
    return c.json({ aliases: rows });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function createAliasHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await createAlias(serverId, {
      domain: String(body.domain ?? ""),
      localPart: body.localPart ? String(body.localPart) : undefined,
      isCatchAll: Boolean(body.isCatchAll),
      destination: String(body.destination ?? ""),
    });
    return c.json({ alias: row }, 201);
  } catch (err) {
    if (err instanceof AliasExistsError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof AliasConflictsWithMailboxError) {
      return c.json({ error: err.message }, 409);
    }
    return errorJson(c, err);
  }
}

export async function updateAliasHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const idParam = c.req.param("id");
  const id = Number(idParam);
  if (!idParam || !Number.isInteger(id)) {
    return c.json({ error: "id must be an integer" }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  if (body.active == null) {
    return c.json({ error: "active is required" }, 400);
  }
  try {
    const row = await updateAliasActive(serverId, id, Boolean(body.active));
    return c.json({ alias: row });
  } catch (err) {
    if (err instanceof AliasNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

export async function deleteAliasHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const idParam = c.req.param("id");
  const id = Number(idParam);
  if (!idParam || !Number.isInteger(id)) {
    return c.json({ error: "id must be an integer" }, 400);
  }
  try {
    await deleteAlias(serverId, id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof AliasNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getStatsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    const stats = await getMailServerStats(serverId);
    return c.json(stats);
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Test email ──────────────────────────────────────────────────────────────

export async function sendTestEmailHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await sendTestEmail(serverId, {
      to: String(body.to ?? ""),
      fromDomain:
        typeof body.fromDomain === "string" && body.fromDomain.trim()
          ? body.fromDomain
          : undefined,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof TestEmailError) {
      return c.json({ error: err.message }, 400);
    }
    return errorJson(c, err);
  }
}

// ─── DNS health scan ─────────────────────────────────────────────────────────

export async function getDnsScanHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    // Optional ?domain= scopes the scan to an additional domain; omitted
    // falls back to the primary install domain inside scanDns.
    const domain = c.req.query("domain");
    const result = await scanDns(serverId, domain);
    return c.json(result);
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Component actions (Health tab) ──────────────────────────────────────────

export async function runComponentActionHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const key = c.req.param("key");
  if (!key) return c.json({ error: "key is required" }, 400);
  const action = c.req.param("action") as ComponentAction | undefined;
  if (!action) return c.json({ error: "action is required" }, 400);
  try {
    const result = await runComponentAction(serverId, key, action);
    return c.json(result);
  } catch (err) {
    if (err instanceof UnknownComponentError) {
      return c.json({ error: err.message }, 400);
    }
    return errorJson(c, err);
  }
}

export async function restartAllComponentsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  try {
    const result = await restartAllComponents(serverId);
    return c.json(result);
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function getComponentLogsHandler(c: Context) {
  const guard = assertNotCloud(c);
  if (guard) return guard;
  const serverId = param(c, "serverId");
  await permission.assert(getRequestContext(c), { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const key = c.req.param("key");
  if (!key) return c.json({ error: "key is required" }, 400);
  const linesParam = c.req.query("lines");
  const requested = linesParam ? Number(linesParam) : undefined;
  try {
    const result = await getComponentLogs(serverId, key, requested);
    return c.json(result);
  } catch (err) {
    if (err instanceof UnknownComponentError) {
      return c.json({ error: err.message }, 400);
    }
    return errorJson(c, err);
  }
}

// ─── Error mapping ───────────────────────────────────────────────────────────

function errorJson(c: Context, err: unknown) {
  // A typed AppError already carries its status + code — MailEngineUnavailableError
  // is the one every read here can raise (a stopped engine / a legacy box whose
  // container never existed), and it must reach the panel as 409 +
  // MAIL_ENGINE_NOT_{INSTALLED,RUNNING} so the UI can offer the fix. Flattening it
  // to 500 is exactly what turned "your mail engine is stopped" into "API 500".
  // The central mapper owns that translation; don't restate it per error type.
  if (err instanceof AppError) return handleApiError(err, c);

  const message = safeErrorMessage(err);
  // The SSH+psql layer throws plain Error for any non-shape error
  // (connection failure, SQL syntax, validation). 500 is the right default;
  // typed errors above are caught and mapped to 4xx individually.
  return c.json({ error: message }, 500);
}
