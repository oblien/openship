/**
 * Domain service - custom domains, DNS verification, SSL certificates.
 *
 * Cloud mode  → CNAME (target from Oblien) + TXT (verification hash)
 * Self-hosted → A record (server IP)       + TXT (verification hash)
 *
 * verifyDomain checks DNS and, on success, kicks off SSL provisioning
 * + promotes the domain to primary if no other custom primary exists.
 * The SSL provisioner (nginx.ts) reads the existing HTTP-only route
 * config off disk and re-registers it with TLS once the cert lands,
 * so no route registration is needed here — the existing infra is
 * reused. SSL provisioning runs in the background; the verify response
 * stays fast and a failed cert (rate-limit, ACME outage) shows up
 * in the SSL status pill on the next read.
 */

import { repos, type Domain, type Project } from "@repo/db";
import { NotFoundError, ConflictError, ValidationError, safeErrorMessage, normalizeCustomHostname, isValidCustomHostname } from "@repo/core";
import { platform, assertResourceInOrg } from "../../lib/controller-helpers";
import { buildBackgroundContext, type RequestContext } from "../../lib/request-context";
import { manageDomainSsl, installDomainCert } from "../../lib/domain-ssl";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { resolveRecords } from "../../lib/dns-resolver";
import { resolveProjectServerHost } from "../../lib/server-target";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { generateToken } from "../../lib/domain-token";
import type { TAddDomainBody } from "./domain.schema";
import type { CloudRuntime, ManualCert } from "@repo/adapters";

// ─── List ────────────────────────────────────────────────────────────────────

export async function listDomains(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  return repos.domain.listByProject(projectId);
}

// ─── Set primary ───────────────────────────────────────────────────────────────

/**
 * Make a domain the project's primary. Primary is the project's canonical
 * hostname — what favicon detection, analytics, and the dashboard's project
 * link resolve to (getPrimaryByProject). setPrimary unsets any prior primary
 * for the project and marks this one, so exactly one row stays primary.
 * Survives redeploys: per-service route registration preserves an existing
 * isPrimary (routing-domains), and project-route sync only touches
 * project-level (serviceId-null) rows.
 */
export async function setPrimaryDomain(ctx: RequestContext, domainId: string) {
  const domain = await repos.domain.findById(domainId);
  if (!domain) throw new NotFoundError("Domain", domainId);
  if (!domain.projectId) throw new NotFoundError("Domain", domainId); // primary is a project-domain concept
  const project = await repos.project.findById(domain.projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, domain.projectId);
  await repos.domain.setPrimary(domain.projectId, domainId);
  return { ...domain, isPrimary: true };
}

// ─── Add ─────────────────────────────────────────────────────────────────────

export async function addDomain(ctx: RequestContext, data: TAddDomainBody) {
  const project = await repos.project.findById(data.projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, data.projectId);

  // Reject obviously-bogus shapes before they ever reach the DB.
  const hostname = normalizeCustomHostname(data.hostname);

  if (!hostname) {
    throw new ValidationError("Hostname is required.");
  }

  // The TypeBox schema (route-level tbValidator) already enforces the
  // hostname regex + length, so anything reaching this point is shaped
  // like a valid DNS name. But the schema doesn't know about managed
  // hostnames — those are free *.opsh.io subdomains that belong in
  // project.publicEndpoints (with domainType="free"), not in the custom-
  // domain table. Refuse them here so users don't accidentally claim a
  // managed slug via the "add custom domain" flow and bypass the free-
  // domain slug picker.
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  if (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)) {
    throw new ValidationError(
      `${baseDomain} subdomains are free managed domains — set them in the project's public endpoints, not as a custom domain.`,
    );
  }

  // Block obvious junk: localhost / IP / single-label / path / scheme leftovers.
  if (!isValidCustomHostname(hostname)) {
    throw new ValidationError(`"${hostname}" is not a valid public hostname.`);
  }

  const existing = await repos.domain.findByHostname(hostname);
  if (existing) {
    if (existing.projectId !== data.projectId) {
      throw new ConflictError(`Domain "${hostname}" is already in use`);
    }

    // Connecting a custom domain is a two-step dashboard flow: create the
    // pending domain row, then attach it to publicEndpoints. If the second
    // request is interrupted (for example while a remote live-route apply is
    // still running), retrying must resume from the existing row instead of
    // trapping the user behind a same-project "already in use" conflict.
    const patch: Partial<Domain> = {};
    if (
      data.externalIngress !== undefined &&
      existing.externalIngress !== data.externalIngress
    ) {
      patch.externalIngress = data.externalIngress;
    }

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
    }
    if (data.isPrimary && !existing.isPrimary) {
      await repos.domain.setPrimary(data.projectId, existing.id);
    }

    const domain = {
      ...existing,
      ...patch,
      ...(data.isPrimary ? { isPrimary: true } : {}),
    };
    const token = domain.verificationToken ?? generateToken(hostname);
    const records = await buildRecords(
      hostname,
      token,
      project,
      domain.externalIngress,
    );
    return { domain, records };
  }

  const token = generateToken(hostname);

  const domain = await repos.domain.create({
    projectId: data.projectId,
    hostname,
    // User-added via POST /domains is always a CUSTOM domain (free
    // managed slugs come in via publicEndpoints — see check above).
    domainType: "custom",
    // Brand-new domain — must be DNS-verified before it's active.
    // The `/verify` endpoint runs the CNAME + TXT check and flips this.
    verified: false,
    status: "pending",
    isPrimary: data.isPrimary ?? false,
    externalIngress: data.externalIngress ?? false,
    verificationToken: token,
  });

  if (data.isPrimary) {
    await repos.domain.setPrimary(data.projectId, domain.id);
  }

  const records = await buildRecords(domain.hostname, token, project, domain.externalIngress);
  return { domain, records };
}

/**
 * Ensure a PENDING custom domain row exists for a SERVICE route, so a
 * service-based project's custom domain flows through the exact same
 * DNS-preflight → pending → verify → SSL pipe as a single-app custom domain.
 * This is the row the routing UI keys Verify / DNS-records / SSL actions on —
 * previously only minted at deploy time (and force-verified), which is why
 * service routes were stuck "Pending" with an edit-only menu.
 *
 * Idempotent: an existing row keeps its verification state (already-verified
 * domains stay green); we only backfill its service/port/type identity.
 */
export async function ensurePendingServiceDomain(opts: {
  projectId: string;
  serviceId: string;
  hostname: string;
  targetPort?: number;
}): Promise<void> {
  const hostname = normalizeCustomHostname(opts.hostname);
  // THROW (was: silent return) so a per-service custom domain gets the same
  // "row + Verify button, or a clear error" contract as project-level addDomain
  // — previously an invalid/taken hostname minted no row and the route card
  // silently showed no Verify affordance with zero feedback.
  if (!isValidCustomHostname(hostname)) {
    throw new ValidationError(`"${opts.hostname}" is not a valid custom domain.`);
  }

  // Project-scoped lookup — only ever read/mutate a row THIS project owns.
  const existing = await repos.domain.findByHostnameForProject(opts.projectId, hostname);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if ((existing.serviceId ?? null) !== opts.serviceId) patch.serviceId = opts.serviceId;
    if (opts.targetPort != null && (existing.targetPort ?? null) !== opts.targetPort) {
      patch.targetPort = opts.targetPort;
    }
    if ((existing.domainType ?? null) !== "custom") patch.domainType = "custom";
    if (Object.keys(patch).length > 0) await repos.domain.update(existing.id, patch);
    return;
  }

  // hostname carries a GLOBAL unique constraint. If another project owns it we
  // must neither create (collision) nor touch theirs (cross-tenant write) —
  // surface it as a conflict (matches addDomain) instead of silently skipping.
  const foreign = await repos.domain.findByHostname(hostname);
  if (foreign) {
    throw new ConflictError(
      `The domain "${hostname}" is already connected to another project.`,
    );
  }

  // findOrCreate (not create) so a concurrent insert of the same brand-new
  // hostname races safely to the existing row instead of throwing 23505 — the
  // caller path (createService) isn't wrapped in a try/catch.
  await repos.domain.findOrCreate({
    projectId: opts.projectId,
    serviceId: opts.serviceId,
    hostname,
    domainType: "custom",
    targetPort: opts.targetPort,
    verified: false,
    status: "pending",
    isPrimary: false,
    verificationToken: generateToken(hostname),
  });
}

/**
 * Tear down a service-derived custom domain row when the service stops routing
 * that hostname (custom domain cleared, switched to free, or port removed). The
 * live proxy is already unregistered by reconcileProjectRoutes; this removes the
 * now-orphaned DB row so the domains list stays a true source of truth.
 *
 * Scoped: only deletes a row THIS service owns (matching serviceId) — never a
 * single-app or cross-service domain that happens to share the hostname.
 */
export async function removeServiceDomain(opts: {
  serviceId: string;
  hostname: string;
}): Promise<void> {
  const hostname = normalizeCustomHostname(opts.hostname);
  if (!hostname) return;

  const existing = await repos.domain.findByHostname(hostname);
  if (existing && (existing.serviceId ?? null) === opts.serviceId) {
    await repos.domain.remove(existing.id);
  }
}

// ─── Preview records (no auth, no DB write) ──────────────────────────────────

export async function previewRecords(hostname: string) {
  const token = generateToken(hostname);
  return buildRecords(hostname, token);
}

// ─── Get DNS records (existing domain) ───────────────────────────────────────

export async function getDomainRecords(ctx: RequestContext, domainId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, ctx.organizationId);
  const token = domain.verificationToken ?? generateToken(domain.hostname);
  return buildRecords(domain.hostname, token, project, domain.externalIngress);
}

// ─── Verify ──────────────────────────────────────────────────────────────────
//
// Checks DNS records and, on success, marks verified + active, promotes
// to primary (when no other custom primary exists), and fires SSL
// provisioning in the background. The SSL provider re-registers the
// route with TLS internally, so no explicit route reconciler is needed.

export async function verifyDomain(ctx: RequestContext, domainId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, ctx.organizationId);

  if (domain.verified) {
    return {
      verified: true,
      cnameVerified: true,
      txtVerified: true,
      message: "Already verified",
      sslStatus: domain.sslStatus,
    };
  }

  const { target } = platform();
  const token = domain.verificationToken ?? generateToken(domain.hostname);
  const external = domain.externalIngress;

  // 1. Routing record — cloud: CNAME via Oblien; self-hosted: A record. With
  //    externally-managed ingress the hostname points at the user's own edge
  //    (Cloudflare/LB), not this box — so there's nothing to check here;
  //    ownership (TXT) alone gates activation.
  const routeOk = external
    ? true
    : target === "cloud"
      ? await verifyCname(domain.hostname)
      : await verifyARecord(domain.hostname, project);

  // 2. Ownership - TXT record with verification hash
  const txtOk = await verifyTxt(domain.hostname, token);

  if (routeOk && txtOk) {
    await repos.domain.markVerified(domainId);

    // Promote to primary when this is a custom domain and no other
    // custom primary exists. Free .opsh.io stays as the always-on
    // fallback but the custom domain now becomes the "real" entry point
    // for analytics and the dashboard's "Visit" link.
    if (domain.projectId && domain.domainType === "custom") {
      const peers = await repos.domain.listByProject(domain.projectId);
      const hasOtherCustomPrimary = peers.some(
        (peer) => peer.id !== domainId && peer.isPrimary && peer.domainType === "custom",
      );
      if (!hasOtherCustomPrimary) {
        await repos.domain.setPrimary(domain.projectId, domainId);
      }
    }

    // Externally-managed ingress: TLS terminates upstream (Cloudflare/LB), so
    // we never run certbot here. Mark SSL "external" and skip provisioning.
    if (external) {
      await repos.domain.updateSsl(domainId, { sslStatus: "external" });
      return {
        verified: true,
        cnameVerified: true,
        txtVerified: true,
        message: "Domain verified — TLS is handled by your external ingress; no certificate is issued here.",
        sslStatus: "external",
      };
    }

    // Background SSL provisioning. Don't await — the verify response
    // stays fast and the SSL status pill updates on the next list read.
    // Failure here is non-fatal: the HTTP route is still up, the user
    // can hit Renew explicitly, and ssl-scheduler picks it up on the
    // next renewal tick once the cert lands.
    void manageDomainSsl(domain.hostname, {
      action: "provision",
      projectId: domain.projectId ?? undefined,
    }).catch((err) => {
      console.error(
        `[DOMAIN] Background SSL provisioning failed for ${domain.hostname}:`,
        safeErrorMessage(err),
      );
    });

    return {
      verified: true,
      cnameVerified: true,
      txtVerified: true,
      message: "Domain verified — SSL provisioning started",
      sslStatus: "provisioning",
    };
  }

  // Persist the failed attempt so the UI can distinguish never-tried /
  // propagating / persistently-failing, and so the auto-verify cron records
  // progress instead of leaving the row an eternal "pending".
  const message = verifyMessage(domain.hostname, token, routeOk, txtOk, target);
  const attempts = await repos.domain.recordVerifyFailure(domainId, message);

  return {
    verified: false,
    recordVerified: routeOk,
    cnameVerified: routeOk, // TEMP alias — dashboard reads this until the Phase 4 UI unify
    txtVerified: txtOk,
    attempts,
    message,
  };
}

// ─── Remove ──────────────────────────────────────────────────────────────────

export async function removeDomain(ctx: RequestContext, domainId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, ctx.organizationId);

  try {
    // Tear the route down on the RIGHT host (remote server / cloud), not the
    // local orchestrator's OpenResty — reconcileProjectRoutes resolves the
    // deployment's own runtime and handles the cloud case.
    const deployment = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
      : null;
    await reconcileProjectRoutes(project, {
      deployment,
      removes: [{ hostname: domain.hostname, isCustomDomain: domain.domainType === "custom" }],
    });
  } catch (err) {
    console.error(`[DOMAIN] Failed to remove route for ${domain.hostname}:`, err);
  }

  await repos.domain.remove(domainId);
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export async function renewDomainSsl(ctx: RequestContext, domainId: string) {
  const { domain } = await getDomainWithAuth(domainId, ctx.organizationId);

  // A manual cert can't be ACME-renewed — the operator must upload a fresh one.
  if (domain.manualSsl) {
    throw new ValidationError(
      "This domain uses a manually uploaded certificate. Upload a new certificate to renew it.",
    );
  }

  const result = await manageDomainSsl(domain.hostname, {
    action: "renew",
  });

  return {
    domain: domain.hostname,
    sslStatus: result.expiresAt ? "active" : "provisioning",
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}

/**
 * Recheck SSL: a READ-ONLY verification that the Let's Encrypt cert is actually
 * present + valid on the serving host (no certbot, no rate-limit cost). Recovers
 * a domain stuck in "provisioning" once its cert is in place, and confirms an
 * existing cert without re-issuing. The no-clobber persist (resolveSslPatch)
 * means a transient read failure leaves an "active" domain untouched.
 */
export async function verifyDomainSsl(ctx: RequestContext, domainId: string) {
  const { domain } = await getDomainWithAuth(domainId, ctx.organizationId);

  const result = await manageDomainSsl(domain.hostname, {
    action: "verify",
  });

  // Re-read the persisted row so the response reflects the no-clobber outcome
  // (a transient read failure leaves an existing "active" untouched).
  const updated = await repos.domain.findById(domainId);

  return {
    domain: domain.hostname,
    sslStatus: updated?.sslStatus ?? (result.verified ? "active" : "provisioning"),
    expiresAt: updated?.sslExpiresAt ?? (result.expiresAt || null),
    issuer: updated?.sslIssuer ?? result.issuer,
    verified: result.verified,
  };
}

/**
 * Install an operator-supplied certificate (BYO / Cloudflare Origin CA) for a
 * verified custom domain. Flips `manualSsl` on so the route planner serves TLS
 * from the uploaded cert and never runs certbot — the piece that gives an
 * externalIngress domain (Cloudflare Full-strict) a real cert at origin.
 */
export async function uploadDomainCert(
  ctx: RequestContext,
  domainId: string,
  cert: ManualCert,
) {
  const { domain } = await getDomainWithAuth(domainId, ctx.organizationId);

  const result = await installDomainCert(domain.hostname, cert, {
    projectId: domain.projectId ?? undefined,
  });

  await repos.domain.update(domainId, {
    manualSsl: true,
    sslStatus: "active",
    sslIssuer: "manual",
    sslExpiresAt: result.expiresAt ? new Date(result.expiresAt) : undefined,
  });

  return {
    domain: domain.hostname,
    sslStatus: "active",
    expiresAt: result.expiresAt,
    issuer: "manual",
  };
}

// ─── Batch pending verification ──────────────────────────────────────────────
//
// Cron / on-demand entrypoint that re-checks DNS for every domain still in
// `pending` state and old enough that the user has had time to add the
// records. Mirrors `renewExpiringCerts` but for the verification half of
// the lifecycle. Called from POST /domains/verify-pending (admin/cron) and
// safe to invoke from a Kubernetes CronJob / systemd timer / external
// scheduler — does not require an authenticated user context.

export interface PendingVerificationResult {
  verified: number;
  stillPending: number;
  failed: number;
  total: number;
  details: Array<{
    hostname: string;
    status: "verified" | "still_pending" | "failed";
    message?: string;
    error?: string;
  }>;
}

export async function verifyPendingDomains(opts?: {
  /**
   * Skip rows added within the last N minutes so a freshly-added domain
   * (still in the Verify-button click window) isn't yanked out from under
   * the user by the cron. Defaults to 10 minutes.
   */
  minAgeMinutes?: number;
  /** Cap iterations per call so a backlog doesn't lock the worker. */
  limit?: number;
}): Promise<PendingVerificationResult> {
  const minAgeMinutes = opts?.minAgeMinutes ?? 10;
  const limit = opts?.limit ?? 50;
  const cutoff = new Date(Date.now() - minAgeMinutes * 60_000);

  const pending = await repos.domain.findPendingVerification(cutoff, limit);
  const result: PendingVerificationResult = {
    verified: 0,
    stillPending: 0,
    failed: 0,
    total: pending.length,
    details: [],
  };

  for (const domain of pending) {
    const project = await repos.project.findById(domain.projectId);
    if (!project) {
      // Project may have been deleted between the find and now — skip,
      // don't fail. The orphan domain row will get cleaned up by
      // deleteByProjectId on the next cascade.
      continue;
    }

    if (!project.organizationId) {
      // Domain belongs to a project with no org binding — skip safely
      // rather than risk a cross-tenant verify.
      continue;
    }

    try {
      // Re-use verifyDomain — same DNS check, same markVerified + isPrimary
      // promotion + background SSL provisioning. Passing the project's
      // organization satisfies the auth check in getDomainWithAuth without
      // the cron needing a session.
      const verifyResult = await verifyDomain(
        buildBackgroundContext({
          userId: "",
          organizationId: project.organizationId,
          label: "domains:verify-pending",
        }),
        domain.id,
      );
      if (verifyResult.verified) {
        result.verified++;
        result.details.push({ hostname: domain.hostname, status: "verified" });
      } else {
        result.stillPending++;
        result.details.push({
          hostname: domain.hostname,
          status: "still_pending",
          message: verifyResult.message,
        });
      }
    } catch (err) {
      result.failed++;
      const message = safeErrorMessage(err);
      result.details.push({
        hostname: domain.hostname,
        status: "failed",
        error: message,
      });
    }
  }

  return result;
}

export async function renewOrgCerts(ctx: RequestContext) {
  const projects = await repos.project.listByOrganization(ctx.organizationId, { page: 1, perPage: 1000 });
  const results: Array<{ domain: string; status: string; error?: string }> = [];

  for (const p of projects.rows) {
    const domains = await repos.domain.listByProject(p.id);
    for (const d of domains) {
      if (d.sslStatus !== "active" || !d.sslExpiresAt) continue;
      const daysLeft = (new Date(d.sslExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysLeft > 14) continue;
      try {
        await renewDomainSsl(ctx, d.id);
        results.push({ domain: d.hostname, status: "renewed" });
      } catch (err) {
        results.push({ domain: d.hostname, status: "failed", error: safeErrorMessage(err) });
      }
    }
  }

  return { renewed: results.filter((r) => r.status === "renewed").length, results };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getDomainWithAuth(
  domainId: string,
  organizationId: string,
): Promise<{ domain: Domain; project: Project }> {
  const domain = await repos.domain.findById(domainId);
  if (!domain) throw new NotFoundError("Domain", domainId);

  const project = await repos.project.findById(domain.projectId);
  assertResourceInOrg(project, "Domain", organizationId, domainId);

  return { domain, project: project as Project };
}

// ── DNS resolution (Google DNS-over-HTTPS → node:dns fallback) ───────────────

// DNS resolution is shared with preflight via apps/api/src/lib/dns-resolver.ts —
// see the imported `resolveRecords` at the top of this file.

// ── DNS checks ───────────────────────────────────────────────────────────────

/** Cloud: ask Oblien if the CNAME is pointing correctly. */
async function verifyCname(hostname: string): Promise<boolean> {
  const { runtime } = platform();
  try {
    const cloud = runtime as CloudRuntime;
    const result = await cloud.verifyDomain(hostname);
    return result.cname;
  } catch {
    return false;
  }
}

/** Self-hosted: check if an A record resolves to our server IP. */
async function verifyARecord(hostname: string, project?: Project): Promise<boolean> {
  const serverIp = await resolveProjectServerHost(project);
  if (!serverIp) return false;

  const records = await resolveRecords(hostname, "A");
  return records.includes(serverIp);
}

/** Check _openship-challenge.{hostname} TXT record for verification token. */
async function verifyTxt(hostname: string, token: string): Promise<boolean> {
  const records = await resolveRecords(`_openship-challenge.${hostname}`, "TXT");
  return records.some((v) => v === token);
}

// ── Record generation ────────────────────────────────────────────────────────

/**
 * A DNS record the user must add.
 *  - `name`: the FULLY-QUALIFIED record name — the authoritative field, and
 *    EXACTLY what `verify*` resolves. Always correct.
 *  - `host`: the name relative to the zone apex, for providers whose UI wants
 *    the sub-label (`@` for apex, `app` for a subdomain). Best-effort via a
 *    2-label registrable-domain heuristic (matches the cookie-domain logic in
 *    config/env.ts); slightly off for multi-part TLDs like `co.uk` — in which
 *    case the user should fall back to the always-correct `name`.
 */
type DnsRecord =
  | { type: "CNAME"; host: string; name: string; value: string }
  | { type: "A"; host: string; name: string; value: string }
  | { type: "TXT"; host: string; name: string; value: string };

/**
 * The sub-label of a hostname relative to its registrable domain, or null for
 * an apex. `app.example.com` → `app`; `a.b.example.com` → `a.b`;
 * `example.com` → null. 2-label heuristic (see DnsRecord.host caveat).
 */
export function relativeSubdomain(hostname: string): string | null {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return null;
  return labels.slice(0, labels.length - 2).join(".");
}

/**
 * The route record (A/CNAME) + TXT ownership record host+name for a hostname.
 * `name` is the FQDN — EXACTLY what verifyARecord/verifyCname/verifyTxt resolve
 * (`hostname` and `_openship-challenge.${hostname}`), so "add the shown records
 * → verify passes" holds by construction. `host` is the zone-relative form.
 * Pure — the unit-test seam for the per-hostname record fix.
 */
export function dnsRecordHosts(hostname: string): {
  routeHost: string;
  routeName: string;
  txtHost: string;
  txtName: string;
} {
  const sub = relativeSubdomain(hostname);
  return {
    routeHost: sub ?? "@",
    routeName: hostname,
    txtHost: sub ? `_openship-challenge.${sub}` : "_openship-challenge",
    txtName: `_openship-challenge.${hostname}`,
  };
}

/**
 * Build the DNS records the user needs to add — with the CORRECT per-hostname
 * host (previously hard-coded to the apex `@`, so a subdomain could never
 * verify: the record was added at the apex while verify checked the subdomain).
 *
 * Cloud       → CNAME <host> → <target from Oblien>
 * Self-hosted → A     <host> → <server public IP>
 * Both        → TXT _openship-challenge[.<sub>] → <verification hash>
 */
async function buildRecords(
  hostname: string,
  token: string,
  project?: Project,
  externalIngress = false,
): Promise<{ mode: "cloud" | "selfhosted" | "external"; records: DnsRecord[] }> {
  const { target, runtime } = platform();

  const { routeHost, routeName, txtHost, txtName } = dnsRecordHosts(hostname);
  const txt: DnsRecord = { type: "TXT", host: txtHost, name: txtName, value: token };

  // Externally-managed ingress: DNS points at the user's own edge
  // (Cloudflare/LB), not this box — so only the ownership TXT is needed.
  if (externalIngress) {
    return { mode: "external", records: [txt] };
  }

  if (target === "cloud") {
    let cnameTarget: string | null = null;
    try {
      const cloud = runtime as CloudRuntime;
      const result = await cloud.verifyDomain(hostname);
      cnameTarget = result.requiredRecords.cname.target;
    } catch { /* Oblien unreachable */ }

    return {
      mode: "cloud",
      records: [{ type: "CNAME", host: routeHost, name: routeName, value: cnameTarget ?? "" }, txt],
    };
  }

  // Self-hosted - A record
  const serverIp = await resolveProjectServerHost(project);
  return {
    mode: "selfhosted",
    records: [{ type: "A", host: routeHost, name: routeName, value: serverIp ?? "" }, txt],
  };
}

/** Build a human-readable verification failure message. */
function verifyMessage(
  hostname: string,
  token: string,
  routeOk: boolean,
  txtOk: boolean,
  target: string,
): string {
  const parts: string[] = [];

  if (!routeOk) {
    parts.push(
      target === "cloud"
        ? `CNAME record not found for ${hostname}`
        : `A record not pointing to server for ${hostname}`,
    );
  }

  if (!txtOk) {
    parts.push(`TXT record _openship-challenge.${hostname} must equal "${token}"`);
  }

  return parts.join(". ");
}
