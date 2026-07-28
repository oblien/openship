import type { Project } from "@repo/db";
import type { ManualCert, SslProvider, SslResult } from "@repo/adapters";
import { ForbiddenError, NotFoundError, SYSTEM } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { platform } from "./controller-helpers";
import { createProvisionLock } from "./provision-lock";
import { resolveDeploymentPlatform, type DeploymentMeta } from "./deployment-runtime";

/**
 * The per-domain issuance lock key. EVERY path that can open an ACME order
 * (manual Verify, `manageDomainSsl` provision/renew, the ssl:renew scheduler
 * which routes through `manageDomainSsl("renew")`) serializes on this exact
 * string so two of them can never run certbot for the same hostname at once —
 * concurrent HTTP-01 challenges collide and burn Let's Encrypt rate-limit
 * budget. In-process mutex (single-process self-hosted) layered over a Postgres
 * advisory lock (multi-instance SaaS); see provision-lock.ts.
 */
function sslIssueLockKey(hostname: string): string {
  return `ssl:issue:${hostname.trim().toLowerCase()}`;
}

/**
 * A cert is "comfortably valid" for REUSE when it's present, parses, and has
 * more life left than the renewal window — i.e. the renewer wouldn't touch it
 * yet. Verify reuses such a cert instead of spending a fresh ACME issuance.
 * (readCertInfo reports `verified:true` for any parseable cert even if expired,
 * so the expiry comparison must live here, not in the adapter.)
 */
function certComfortablyValid(result: SslResult): boolean {
  if (!result.verified || !result.expiresAt) return false;
  const daysLeft = (new Date(result.expiresAt).getTime() - Date.now()) / 86_400_000;
  return daysLeft > SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS;
}

export type DomainSslAction = "provision" | "renew" | "verify";

interface DomainSslOptions {
  action: DomainSslAction;
  /** Restrict to a specific project (defense-in-depth; route layer
   *  already verified access). */
  projectId?: string;
  includeWww?: boolean;
  /** Skip the "must be verified first" guard. Only the ACME-as-verification
   *  path (self-hosted verifyDomain) sets this — there, issuing the cert IS the
   *  verification, so it necessarily runs before `verified` is set. */
  allowUnverified?: boolean;
}

async function resolveAuthorizedDomain(hostname: string, opts: DomainSslOptions) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  if (!project) throw new NotFoundError("Domain", hostname);

  // Access verification is enforced at the route boundary
  // (requirePermission middleware checks org membership before the
  // controller runs). The optional projectId is a defense-in-depth scope.
  if (opts.projectId && domainRecord.projectId !== opts.projectId) {
    throw new NotFoundError("Domain", hostname);
  }

  if (!opts.allowUnverified && !domainRecord.verified) {
    throw new ForbiddenError("Domain must be verified before SSL can be managed");
  }

  return { domainRecord, project };
}

/**
 * Decide how to persist an SSL outcome WITHOUT clobbering a healthy domain on a
 * transient failure. Returns the `updateSsl` patch, or `null` meaning "leave the
 * current row untouched". The single source of truth for SSL-status transitions,
 * shared by the on-demand path (manageDomainSsl) and the deploy-time tracker
 * (createTrackedSslProvider). Rules:
 *   - verified cert read     → "active" (+ expiry, issuer)
 *   - transient read failure → null (a redeploy that briefly can't read the cert
 *                              must NOT downgrade a live "active" to "provisioning")
 *   - cert genuinely missing → "provisioning" (still being issued)
 */
export function resolveSslPatch(
  currentStatus: string | null | undefined,
  result: SslResult,
): { sslStatus: string; sslIssuer?: string; sslExpiresAt?: Date } | null {
  if (result.verified && result.expiresAt) {
    return {
      sslStatus: "active",
      sslIssuer: result.issuer,
      sslExpiresAt: new Date(result.expiresAt),
    };
  }
  if (result.reason === "read_error" && currentStatus === "active") {
    return null;
  }
  return { sslStatus: "provisioning", sslIssuer: result.issuer };
}

async function persistSslResult(
  domainId: string,
  currentStatus: string | null | undefined,
  result: SslResult,
) {
  const patch = resolveSslPatch(currentStatus, result);
  if (patch) await repos.domain.updateSsl(domainId, patch);
}

/**
 * Resolve the SSL provider that runs on the SAME host that serves the domain.
 *
 * certbot must execute on the box whose OpenResty serves the vhost and whose
 * `/var/www/acme` webroot answers the ACME HTTP-01 challenge. For a self-hosted
 * deploy targeting a remote SSH server, that box is the DEPLOY TARGET — not the
 * orchestrator the API booted on. The global `platform()` is the orchestrator,
 * so using it would run certbot on the wrong host (no vhost, no webroot → the
 * challenge can never succeed). Resolve the project's active-deployment platform
 * instead — the same per-server resolution the deploy itself used.
 *
 * Falls back to the global platform when the project has no active deployment
 * yet (single-box installs resolve to the same local provider either way).
 */
async function resolveSslProvider(project: Project): Promise<SslProvider> {
  const depId = project.activeDeploymentId;
  if (depId) {
    const dep = await repos.deployment.findById(depId);
    if (dep) {
      const meta = (dep.meta ?? {}) as DeploymentMeta;
      try {
        const resolved = await resolveDeploymentPlatform(meta, { organizationId: dep.organizationId });
        return resolved.platform.ssl;
      } catch {
        // Deploy target unresolvable — fall through to the host-anchored fallback.
      }
    }
  }

  // Fallback anchor. `platform().ssl` is the API's OWN context — for a
  // containerized API that's the API container (no edge/OpenResty there) or a
  // DockerEdgeExecutor for a non-existent `openship-edge`, so certbot's HTTP-01
  // never resolves and issuance/verify silently fails. Resolve the self-hosted
  // instance's LOCAL host-server instead (createHostExecutor → the bare host's
  // OpenResty + /etc/letsencrypt), which is where the edge actually lives.
  //
  // NOT in desktop mode: there the "local host" is the user's LAPTOP, not the
  // remote server whose edge serves the domain — a project's edge always lives
  // on its deployment server (resolved above via serverId → SSH). The primary
  // path handles that; this local anchor is only for a server-host install.
  if (!env.CLOUD_MODE && env.DEPLOY_MODE !== "desktop") {
    const local = await repos.server.findLocal(project.organizationId).catch(() => null);
    if (local) {
      try {
        const resolved = await resolveDeploymentPlatform(
          { serverId: local.id } as DeploymentMeta,
          { organizationId: project.organizationId },
        );
        return resolved.platform.ssl;
      } catch {
        // Host-server unresolvable — last resort below.
      }
    }
  }
  return platform().ssl;
}

async function executeSslAction(
  ssl: SslProvider,
  hostname: string,
  action: DomainSslAction,
): Promise<SslResult> {
  switch (action) {
    case "renew":
      return ssl.renewCert(hostname);
    case "verify":
      return ssl.verifyCert(hostname);
    default:
      return ssl.provisionCert(hostname);
  }
}

// NOTE on the toolchain (certbot/OpenResty): we deliberately do NOT install it
// here. Installing certbot can take 30–90s, which blows the renew HTTP request's
// timeout. Toolchain install lives in the DEPLOY step chain instead — the deploy
// preflight runs `system.ensureFeature("ssl", …)` whenever a planned domain has
// `provisionSsl` (see build-pipeline.ts), streaming the install logs into the
// deploy output. So a custom domain gets certbot installed AND its cert issued
// as part of a normal deploy; this on-demand path only issues/renews against an
// already-provisioned host (and surfaces a clear error if the toolchain is
// missing — i.e. "redeploy to set up SSL").
export async function manageDomainSsl(
  hostname: string,
  opts: DomainSslOptions,
): Promise<SslResult> {
  const { domainRecord, project } = await resolveAuthorizedDomain(hostname, opts);
  const ssl = await resolveSslProvider(project);
  // `verify` is a read-only cert inspection (no ACME) → no lock. `provision`/
  // `renew` can open an ACME order, so serialize them per-hostname on the shared
  // issue lock — this is what stops the ssl:renew scheduler (which calls us with
  // action:"renew") from racing a manual Verify on the same domain.
  const runAction = (h: string, a: DomainSslAction): Promise<SslResult> =>
    a === "verify"
      ? executeSslAction(ssl, h, a)
      : createProvisionLock(sslIssueLockKey(h)).run(() => executeSslAction(ssl, h, a));

  const result = await runAction(domainRecord.hostname, opts.action);
  await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);

  if (opts.includeWww) {
    const wwwHostname = `www.${domainRecord.hostname}`;
    const wwwRecord = await repos.domain.findByHostname(wwwHostname);

    if (wwwRecord && wwwRecord.projectId === domainRecord.projectId && wwwRecord.verified) {
      // Same project → same host → reuse the resolved provider.
      const wwwResult = await runAction(wwwRecord.hostname, opts.action);
      await persistSslResult(wwwRecord.id, wwwRecord.sslStatus, wwwResult);
    }
  }

  return result;
}

/**
 * ACME-as-verification for a self-hosted custom domain: obtain the cert for a
 * NOT-YET-VERIFIED domain. A successful issuance IS the proof that the hostname
 * resolves to this box and :80 is reachable — and it holds behind a CDN:
 * Cloudflare forwards the HTTP-01 challenge (proxied by the edge to certbot's
 * standalone server) to origin. That's why self-hosted verify drives this
 * instead of digging DNS, which a proxy in front would answer with the CDN's own
 * IP. `onLog` streams certbot's output live to the verify modal. Returns the
 * SslResult ({verified} on success); propagates the summarized certbot failure
 * so the caller can surface an actionable "not yet" message. Persisted on exit.
 */
export async function provisionDomainCertForVerify(
  hostname: string,
  opts: { projectId?: string; onLog?: (line: string) => void; force?: boolean } = {},
): Promise<SslResult> {
  const { domainRecord, project } = await resolveAuthorizedDomain(hostname, {
    action: "provision",
    projectId: opts.projectId,
    allowUnverified: true,
  });
  const ssl = await resolveSslProvider(project);

  // Serialize issuance per-hostname, and re-check the cert INSIDE the lock.
  // This closes the TOCTOU: two concurrent Verify hits (or Verify racing the
  // renewal scheduler) both queue on the lock; the first issues, and the second
  // — now inside the lock — sees the freshly-issued cert and reuses it instead
  // of opening a second ACME order. The service-level fast-path in verifyDomain
  // is only a cheap read-only optimization; THIS is the authoritative gate.
  const result = await createProvisionLock(sslIssueLockKey(domainRecord.hostname)).run(async () => {
    if (!opts.force) {
      const existing = await ssl.verifyCert(domainRecord.hostname).catch(() => null);
      if (existing && certComfortablyValid(existing)) {
        opts.onLog?.(
          `A valid certificate is already present for ${domainRecord.hostname}` +
            (existing.expiresAt ? ` (expires ${existing.expiresAt.slice(0, 10)})` : "") +
            " — reusing it. No new certificate requested.",
        );
        return existing;
      }
    }
    // Decided to issue (missing / near-expiry / forced): pass `force` so the
    // adapter runs certbot even when a stale cert file is present on disk —
    // otherwise its file-exists short-circuit would return the old cert and a
    // near-expiry renewal would silently no-op.
    return ssl.provisionCert(domainRecord.hostname, { onLog: opts.onLog, force: true });
  });

  await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);
  return result;
}

/**
 * Install an operator-supplied certificate on the host that serves the domain
 * (resolved the same way as manageDomainSsl). Infra-only — the caller owns the
 * domain-row update (manualSsl flag + ssl status). Enforces the same ownership
 * + verified guards as the other SSL actions.
 */
export async function installDomainCert(
  hostname: string,
  cert: ManualCert,
  opts: { projectId?: string; allowUnverified?: boolean } = {},
): Promise<SslResult> {
  const { domainRecord, project } = await resolveAuthorizedDomain(hostname, {
    action: "provision",
    projectId: opts.projectId,
    allowUnverified: opts.allowUnverified,
  });
  const ssl = await resolveSslProvider(project);
  return ssl.installCert(domainRecord.hostname, cert);
}

/**
 * Read-only check: is a usable cert for this hostname ALREADY present on the
 * host that serves it (e.g. left by a prior deploy of the same box)? No
 * issuance, no ACME rate-limit cost. Allows a not-yet-verified row — the
 * migration/first-publish reuse path (domain.service → reuseServerCertForDomain)
 * runs before the domain is verified, so it can't use manageDomainSsl (which
 * gates on `verified`). Persists an "active" result via resolveSslPatch.
 */
export async function verifyExistingCert(
  hostname: string,
  opts: { projectId?: string } = {},
): Promise<SslResult> {
  const { domainRecord, project } = await resolveAuthorizedDomain(hostname, {
    action: "verify",
    projectId: opts.projectId,
    allowUnverified: true,
  });
  const ssl = await resolveSslProvider(project);
  const result = await ssl.verifyCert(domainRecord.hostname);
  await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);
  return result;
}