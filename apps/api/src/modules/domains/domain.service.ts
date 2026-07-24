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
import { manageDomainSsl, installDomainCert, provisionDomainCertForVerify, verifyExistingCert } from "../../lib/domain-ssl";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { resolveRecords } from "../../lib/dns-resolver";
import { resolveProjectServerHost } from "../../lib/server-target";
import { reconcileProjectRoutes } from "../../lib/route-apply.service";
import { generateToken } from "../../lib/domain-token";
import { sshManager } from "../../lib/ssh-manager";
import type { DeploymentMeta } from "../../lib/deployment-runtime";
import { scanProxyRoutesWithExecutor } from "../migration/proxy-route-scan";
import type { TAddDomainBody } from "./domain.schema";
import type { CloudRuntime, CommandExecutor, ManualCert } from "@repo/adapters";

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
}): Promise<{ created: boolean; domainId: string | null }> {
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
    return { created: false, domainId: existing.id };
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
  const row = await repos.domain.findOrCreate({
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
  return { created: true, domainId: row?.id ?? null };
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

/**
 * Promote a custom domain to primary when no OTHER custom primary exists. Free
 * .opsh.io stays the always-on fallback; the custom domain becomes the "real"
 * entry point for analytics + the "Visit" link. Shared by verify + cert-reuse.
 */
async function promoteCustomDomainToPrimary(domain: Domain, domainId: string): Promise<void> {
  if (domain.projectId && domain.domainType === "custom") {
    const peers = await repos.domain.listByProject(domain.projectId);
    const hasOtherCustomPrimary = peers.some(
      (peer) => peer.id !== domainId && peer.isPrimary && peer.domainType === "custom",
    );
    if (!hasOtherCustomPrimary) await repos.domain.setPrimary(domain.projectId, domainId);
  }
}

/** Flip a row to verified + SSL active (+ promote), reusing an existing cert. */
async function markDomainVerifiedActive(
  domain: Domain,
  domainId: string,
  ssl: { issuer?: string; expiresAt?: string; manualSsl?: boolean },
): Promise<void> {
  await repos.domain.markVerified(domainId);
  await promoteCustomDomainToPrimary(domain, domainId);
  await repos.domain.updateSsl(domainId, {
    sslStatus: "active",
    ...(ssl.manualSsl ? { manualSsl: true } : {}),
    ...(ssl.issuer ? { sslIssuer: ssl.issuer } : {}),
    ...(ssl.expiresAt ? { sslExpiresAt: new Date(ssl.expiresAt) } : {}),
  });
}

/** The server the project's active deployment runs on (for edge/cert reads). */
async function resolveServerIdForProject(project: Project): Promise<string | null> {
  if (!project.activeDeploymentId) return null;
  const dep = await repos.deployment.findById(project.activeDeploymentId).catch(() => null);
  return (dep?.meta as DeploymentMeta | undefined)?.serverId ?? null;
}

/**
 * Run `fn` with an executor that reaches the BOX the project's edge lives on —
 * the same host the bare/containerized OpenResty + certbot + /etc/letsencrypt sit
 * on. For the auto-registered "this server" (server-host mode) that's
 * `createHostExecutor()` (the LOCAL host — SSH-to-host when the API is itself
 * containerized); for a real remote server it's the pooled SSH executor. Returns
 * null when there's no server or the box is unreachable. This is what lets cert
 * reuse read the HOST's /etc/letsencrypt even when the API runs in a container
 * whose own /etc/letsencrypt is a different (empty) volume.
 */
async function withServerHostExecutor<T>(
  ctx: RequestContext,
  project: Project,
  fn: (exec: CommandExecutor) => Promise<T>,
): Promise<T | null> {
  const serverId = await resolveServerIdForProject(project);
  if (!serverId) return null;
  const server = await repos.server.getInOrganization(serverId, ctx.organizationId).catch(() => null);
  if (server?.isLocal) {
    const { createHostExecutor } = await import("@repo/adapters");
    return fn(createHostExecutor());
  }
  return sshManager.withExecutor(serverId, fn).catch(() => null);
}

/**
 * Bare-metal edge, but the SSL executor lands INSIDE a container: every SSL op
 * (certbot, cert read, vhost write) then hits the container's own (empty)
 * `/etc/letsencrypt`, not the host's bare OpenResty — so it silently no-ops.
 *
 * Probed THROUGH the resolved host executor (not the API's own `node:fs`) so the
 * verdict reflects where SSL ops ACTUALLY land: a bare API's LocalExecutor OR an
 * SSH-to-host executor targets the real host (no container marker → reachable);
 * only a containerized API with no host channel lands in a container. Docker-edge
 * mode shares the cert volume, so it's never "unreachable" there.
 */
async function edgeHostUnreachable(ctx: RequestContext, project: Project): Promise<boolean> {
  if (process.env.OPENSHIP_EDGE_MODE === "docker") return false;
  // Only the LOCAL host-server can be "unreachable from a container" (a
  // containerized API with no host channel). A REMOTE server is reached over SSH
  // by definition — the SSH executor lands on its host, never a container — so
  // skip the probe entirely (it's a wasted SSH round-trip that would otherwise be
  // the FIRST, feedback-less blocking call and make verify look hung).
  const serverId = await resolveServerIdForProject(project);
  if (!serverId) return false;
  const server = await repos.server.getInOrganization(serverId, ctx.organizationId).catch(() => null);
  if (!server?.isLocal) return false;
  const { createHostExecutor } = await import("@repo/adapters");
  const exec = createHostExecutor();
  return (
    (await exec.exists("/.dockerenv").catch(() => false)) ||
    (await exec.exists("/run/.containerenv").catch(() => false))
  );
}

const HOST_CHANNEL_HINT =
  "This server runs a bare-metal edge, but Openship's API is in a container that can't reach the host's " +
  "OpenResty or /etc/letsencrypt to manage TLS. Provision the host SSH channel (OPENSHIP_HOST_SSH_*, e.g. " +
  "via `openship up`), or bind-mount the host's /etc/letsencrypt + OpenResty sites into the API container.";

/** Guard a hostname before it's interpolated into a filesystem path (defence in
 *  depth — the row is already validated at creation). */
function isPathSafeHostname(hostname: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(hostname) && !hostname.includes("..");
}

/**
 * Migration / first-publish SSL reuse. When a custom-domain row is freshly minted
 * for a hostname the SERVER ALREADY serves — an Openship re-migration on the same
 * box, or a foreign reverse proxy (nginx bare OR container) we're taking over —
 * adopt the cert that's already there instead of re-issuing via ACME (which fails
 * behind Cloudflare, or when the cert isn't at certbot's standard path). Sources,
 * in order, all read on the HOST executor so it works when the API is containerized:
 *   1. certbot's /etc/letsencrypt on the serving host, via the platform provider
 *      (verifyExistingCert).
 *   2. the host's /etc/letsencrypt/live/<host>/{fullchain,privkey}.pem read
 *      directly on the HOST executor — the bare-edge case where the API
 *      container's own /etc/letsencrypt is a different volume.
 *   3. the edge vhost's cert files (scanProxyRoutes → certPath/keyPath), read off
 *      the host and installed as a manual cert (foreign-proxy migration).
 * Self-hosted only; best-effort + non-fatal (domains never fail a deploy, see
 * [[domains-never-fail-deploy]]). No-op when nothing is reusable → the row stays
 * pending for the manual Verify (ACME) path. Returns true when it adopted a cert.
 */
export async function reuseServerCertForDomain(ctx: RequestContext, domainId: string): Promise<boolean> {
  try {
    const { domain, project } = await getDomainWithAuth(domainId, ctx.organizationId);
    if (domain.verified) return true; // already good — nothing to reuse
    // Cloud domains verify via Oblien (CNAME); reuse is a self-hosted concept.
    if (platform().target === "cloud" || project.cloudWorkspaceId) return false;
    // Can't reach the host from inside the container → nothing to reuse here; the
    // manual Verify surfaces the actionable host-channel hint.
    if (await edgeHostUnreachable(ctx, project)) {
      console.warn(`[DOMAIN] cert reuse skipped for ${domain.hostname}: ${HOST_CHANNEL_HINT}`);
      return false;
    }

    const installReused = async (cert: ManualCert) => {
      const result = await installDomainCert(domain.hostname, cert, {
        projectId: domain.projectId ?? undefined,
        allowUnverified: true,
      });
      await markDomainVerifiedActive(domain, domainId, {
        issuer: "reused",
        manualSsl: true,
        expiresAt: result.expiresAt || undefined,
      });
    };

    // 1. A cert is already at certbot's standard path, reachable via the platform
    //    provider (host-anchored for the local server-host).
    const existing = await verifyExistingCert(domain.hostname, {
      projectId: domain.projectId ?? undefined,
    }).catch(() => null);
    if (existing?.verified) {
      await markDomainVerifiedActive(domain, domainId, {
        issuer: existing.issuer,
        expiresAt: existing.expiresAt || undefined,
      });
      return true;
    }

    // 2. Read the host's /etc/letsencrypt directly on the HOST executor — covers a
    //    bare-metal edge whose certs live on the host while the API container's own
    //    /etc/letsencrypt is a separate, empty volume.
    if (isPathSafeHostname(domain.hostname)) {
      const base = `/etc/letsencrypt/live/${domain.hostname}`;
      const hostCert = await withServerHostExecutor(ctx, project, async (exec) => {
        const certPem = await exec.readFile(`${base}/fullchain.pem`).catch(() => "");
        const keyPem = await exec.readFile(`${base}/privkey.pem`).catch(() => "");
        return certPem.trim() && keyPem.trim() ? { certPem, keyPem } : null;
      }).catch(() => null);
      if (hostCert) {
        await installReused(hostCert);
        return true;
      }
    }

    // 3. A cert served by the edge vhost (our OpenResty at a non-standard path, or
    //    a foreign proxy we're migrating from) — scan the edge + read the
    //    referenced files, all on the HOST executor so it works on the local
    //    host-server too (scanProxyRoutes' own sshManager can't reach that box).
    const host = domain.hostname.toLowerCase();
    const cert = await withServerHostExecutor(ctx, project, async (exec) => {
      const routes = await scanProxyRoutesWithExecutor(exec);
      const match = [...routes.values()].find(
        (r) => r.ssl.enabled && r.ssl.certPath && r.ssl.keyPath && r.domains.some((d) => d.toLowerCase() === host),
      );
      if (!match?.ssl.certPath || !match.ssl.keyPath) return null;
      return { certPem: await exec.readFile(match.ssl.certPath), keyPem: await exec.readFile(match.ssl.keyPath) };
    }).catch(() => null);
    if (!cert?.certPem?.trim() || !cert?.keyPem?.trim()) return false;
    await installReused(cert);
    return true;
  } catch (err) {
    console.error(`[DOMAIN] cert reuse failed for ${domainId}:`, safeErrorMessage(err));
    return false;
  }
}

// ─── Verify ──────────────────────────────────────────────────────────────────
//
// Checks DNS records and, on success, marks verified + active, promotes
// to primary (when no other custom primary exists), and fires SSL
// provisioning in the background. The SSL provider re-registers the
// route with TLS internally, so no explicit route reconciler is needed.

export async function verifyDomain(
  ctx: RequestContext,
  domainId: string,
  opts: { onLog?: (line: string) => void } = {},
) {
  const log = (line: string) => opts.onLog?.(line);
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
  const external = domain.externalIngress;

  const promoteToPrimary = () => promoteCustomDomainToPrimary(domain, domainId);

  // ── Self-hosted: ACME-driven verification ─────────────────────────────────
  // The operator owns the box, so there's no ownership challenge to prove, and
  // we must NOT dig DNS: a CDN/Cloudflare in front resolves the hostname to the
  // proxy — not this server — so an A-record check would always "fail". Instead
  // we prove control the one way that survives a proxy: obtain the TLS cert.
  // certbot's HTTP-01 challenge is forwarded to origin by the CDN over :80, so a
  // successful issuance means the hostname really points here and :80/:443 are
  // reachable. That single check replaces the old A-record + TXT-challenge dig.
  if (target !== "cloud") {
    // externalIngress: TLS terminates at the operator's OWN edge (they may have
    // firewalled origin :80 to CDN IPs, or run Cloudflare "Flexible"), so ACME
    // can't run here. Accept ownership by fiat — self-hosted, operator-owned box
    // — and let their edge serve TLS.
    if (external) {
      log("External ingress — TLS handled upstream; marking verified without issuing a cert.");
      await repos.domain.markVerified(domainId);
      await promoteToPrimary();
      await repos.domain.updateSsl(domainId, { sslStatus: "external" });
      return {
        verified: true,
        recordVerified: true,
        cnameVerified: true,
        txtVerified: true,
        message: "Domain verified — TLS is handled by your external ingress; no certificate is issued here.",
        sslStatus: "external",
      };
    }

    // A containerized API with no host channel can't drive certbot on the bare
    // host edge — running it would fail confusingly against the container's own
    // /etc/letsencrypt. Surface the actionable reason instead.
    if (await edgeHostUnreachable(ctx, project)) {
      log(HOST_CHANNEL_HINT);
      const attempts = await repos.domain.recordVerifyFailure(domainId, HOST_CHANNEL_HINT);
      return { verified: false, recordVerified: false, cnameVerified: false, txtVerified: false, attempts, message: HOST_CHANNEL_HINT };
    }

    // Fast-fail a dead/slow REMOTE server (~2.5s TCP probe) with a clear message
    // + immediate "connecting" feedback, instead of hanging on the full SSH
    // connect timeout while the modal sits on a blank "Connecting…".
    const serverId = await resolveServerIdForProject(project);
    if (serverId) {
      const server = await repos.server.getInOrganization(serverId, ctx.organizationId).catch(() => null);
      if (server && !server.isLocal) {
        log(`Connecting to ${server.name || server.sshHost || "the server"}…`);
        const reachable = await sshManager.probeReachable(serverId).catch(() => false);
        if (!reachable) {
          const message = `Can't reach ${server.sshHost || "the server"} over SSH — check it's online and reachable, then Verify again.`;
          log(message);
          const attempts = await repos.domain.recordVerifyFailure(domainId, message);
          return { verified: false, recordVerified: false, cnameVerified: false, txtVerified: false, attempts, message };
        }
      }
    }

    try {
      log(`Requesting a certificate for ${domain.hostname} (standalone HTTP-01 via the edge)…`);
      const result = await provisionDomainCertForVerify(domain.hostname, {
        projectId: domain.projectId ?? undefined,
        onLog: opts.onLog,
      });
      if (result.verified) {
        log("Certificate issued — marking the domain verified and SSL active.");
        await repos.domain.markVerified(domainId);
        await promoteToPrimary();
        return {
          verified: true,
          recordVerified: true,
          cnameVerified: true,
          txtVerified: true,
          message: "Domain verified — certificate issued.",
          sslStatus: "active",
        };
      }
      // certbot returned WITHOUT throwing but the cert isn't readable/usable
      // (reason "missing" = no cert on this edge → likely running against the
      // wrong edge/executor; "read_error" = cert present but unreadable). Surface
      // the reason so the failure mode is diagnosable, not a generic "not yet".
      const detail =
        result.reason === "read_error"
          ? "a certificate exists but couldn't be read on the edge"
          : "no certificate was produced on the edge that serves this domain";
      const message =
        `Couldn't confirm a certificate (${detail}). Make sure the domain points at this server (a CDN like ` +
        `Cloudflare in front is fine) and ports 80/443 are reachable, then Verify again.`;
      const attempts = await repos.domain.recordVerifyFailure(domainId, message);
      return { verified: false, recordVerified: false, cnameVerified: false, txtVerified: false, attempts, message };
    } catch (err) {
      // summarizeCertbotFailure (adapters) already mapped this to the real cause
      // — DNS not resolving, :80 firewalled, or a proxy 404. Surface it verbatim.
      const message = safeErrorMessage(err);
      const attempts = await repos.domain.recordVerifyFailure(domainId, message);
      return { verified: false, recordVerified: false, cnameVerified: false, txtVerified: false, attempts, message };
    }
  }

  // ── Cloud (Oblien-managed): CNAME via Oblien + ownership TXT ───────────────
  const token = domain.verificationToken ?? generateToken(domain.hostname);
  const routeOk = external ? true : await verifyCname(domain.hostname);
  const txtOk = await verifyTxt(domain.hostname, token);

  if (routeOk && txtOk) {
    await repos.domain.markVerified(domainId);
    await promoteToPrimary();

    // Externally-managed ingress: TLS terminates upstream, so no certbot here.
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

    // Background SSL provisioning. Don't await — the verify response stays fast
    // and the SSL status pill updates on the next list read. Failure is
    // non-fatal: HTTP route stays up, Renew + the ssl-scheduler recover it.
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
      // Include "error": a domain whose last renew failed still needs retrying,
      // otherwise this org-wide sweep can't recover a stuck cert either.
      if ((d.sslStatus !== "active" && d.sslStatus !== "error") || !d.sslExpiresAt) continue;
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

  if (target === "cloud") {
    // Cloud (Oblien-managed): CNAME to the edge + an ownership TXT, since a
    // shared multi-tenant edge genuinely needs to prove who owns the hostname.
    const txt: DnsRecord = { type: "TXT", host: txtHost, name: txtName, value: token };
    if (externalIngress) {
      return { mode: "external", records: [txt] };
    }
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

  // ── Self-hosted ──
  // No ownership TXT: the operator owns the box, and verification is ACME-driven
  // (issuing the cert IS the proof), not a DNS dig.
  if (externalIngress) {
    // DNS points at the operator's own edge (Cloudflare/LB), not this box —
    // there's nothing for us to hand them.
    return { mode: "external", records: [] };
  }
  // A record is GUIDANCE only ("point it here"). We never resolve it — a CDN in
  // front would answer with its own IP — so it's a hint, not a gate.
  const serverIp = await resolveProjectServerHost(project);
  return {
    mode: "selfhosted",
    records: [{ type: "A", host: routeHost, name: routeName, value: serverIp ?? "" }],
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
