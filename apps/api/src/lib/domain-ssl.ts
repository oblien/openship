import type { Domain, Project } from "@repo/db";
import type { ManualCert, SslProvider, SslResult } from "@repo/adapters";
import { ForbiddenError, NotFoundError, SYSTEM, safeErrorMessage } from "@repo/core";
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
export function sslIssueLockKey(hostname: string): string {
  return `ssl:issue:${hostname.trim().toLowerCase()}`;
}

/**
 * The per-BOX ACME lock. `sslIssueLockKey` serializes one hostname against
 * itself; this serializes every hostname on a box against every other, because
 * certbot's standalone authenticator binds a single loopback port
 * (`ACME_HTTP01_PORT`) that the edge proxies the challenge to. Two hostnames
 * issuing at once therefore fight over that port and one dies with
 * "Could not bind TCP port" — a failure that reads like a DNS problem and isn't.
 *
 * Unreachable with one custom domain per project, which is why it went unnoticed;
 * "Include www" makes two the normal case, so a manual Verify on the apex can now
 * collide with the pending-SSL sweep issuing for the www sibling. Taken INSIDE
 * the per-hostname lock, so lock ordering is always hostname → box.
 *
 * `scope` is the serving server's id, or "local" for the box the API runs on —
 * different servers keep issuing in parallel.
 */
export function acmeIssueLockKey(scope: string): string {
  return `ssl:acme:${scope}`;
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

/** Why a domain's TLS is not certbot's job on the serving box. */
export type TlsIssuedElsewhere = "external_ingress" | "manual_cert" | "managed_edge";

/**
 * Is TLS for this domain issued/terminated somewhere OTHER than certbot on the box
 * that serves it? Returns the reason, or null when we really do issue it here.
 *
 * THE one place this question is answered. It used to be answered five times, in
 * five vocabularies, by whoever happened to be calling: `skipSsl` in the routing
 * planner, `external` in the route planner and in `verifyDomain`, a `skipCert`
 * boolean threaded through the self-app edge provisioner, and an inline
 * `domainType !== "free"` in the boot reconcile. Each new cert caller had to
 * rediscover it, and the one that forgot burned a Let's Encrypt attempt on a
 * hostname whose A record points at someone else's edge.
 *
 *   externalIngress → TLS terminates at the operator's own proxy/CDN; ACME can't
 *                     run here (origin :80 may be firewalled to CDN IPs).
 *   manualSsl       → operator-uploaded cert (BYO / Cloudflare Origin CA). certbot
 *                     never issued it, so `renew` would error and flip it to
 *                     "error".
 *   free            → a managed `*.opsh.io` host: Openship Cloud's edge terminates
 *                     TLS and forwards to plain :80 here. The box usually has no
 *                     public A record for the name at all, so HTTP-01 cannot pass.
 */
export function tlsIssuedElsewhere(domain: {
  domainType?: string | null;
  externalIngress?: boolean | null;
  manualSsl?: boolean | null;
}): TlsIssuedElsewhere | null {
  if (domain.externalIngress) return "external_ingress";
  if (domain.manualSsl) return "manual_cert";
  if (domain.domainType === "free") return "managed_edge";
  return null;
}

/** Operator-facing one-liner for {@link tlsIssuedElsewhere}. */
export function describeTlsIssuedElsewhere(
  where: TlsIssuedElsewhere,
  hostname: string,
): string {
  switch (where) {
    case "external_ingress":
      return `TLS for ${hostname} terminates at your own ingress — no certificate is issued here.`;
    case "manual_cert":
      return `${hostname} serves an uploaded certificate — certbot is not run for it.`;
    default:
      return `TLS for ${hostname} is handled by Openship Cloud — no local certificate needed.`;
  }
}

interface DomainSslOptions {
  action: DomainSslAction;
  /** Restrict to a specific project (defense-in-depth; route layer
   *  already verified access). */
  projectId?: string;
  /** Skip the "must be verified first" guard. Only the ACME-as-verification
   *  path (self-hosted verifyDomain) sets this — there, issuing the cert IS the
   *  verification, so it necessarily runs before `verified` is set. */
  allowUnverified?: boolean;
}

/** The lock scope for the box the API itself runs on. */
export const LOCAL_ACME_SCOPE = "local";

/** An SSL provider plus the ACME lock scope of the box it drives. */
interface ResolvedSslProvider {
  ssl: SslProvider;
  /** {@link acmeIssueLockKey} scope — the serving server's id, or "local". */
  lockScope: string;
}

/** `domain.ownerType` for the `mail.<base>` host of a mail server. */
export const MAIL_DOMAIN_OWNER = "mail";

/**
 * Who owns a domain for SSL purposes.
 *
 * Almost every row is project-owned and resolves its provider from the project's
 * active deployment. A MAIL-owned row has no project at all — the mail wizard's
 * `mail.<base>` host is a certificate on a box, not an app — so it resolves from
 * the mail server directly.
 */
type SslOwner =
  | { kind: "project"; project: Project }
  | { kind: "mail"; serverId: string; organizationId: string };

/**
 * The mail server behind a `mail.<base>` hostname, or null when there isn't one.
 *
 * Derived from the hostname rather than an FK on the row: `mail.<base>` is already
 * the convention the wizard builds and step 13 symlinks certs by, and
 * `mail_servers` is already the canonical base-domain → server record — so a
 * fourth owner column on `domain` would only be a second copy of that mapping,
 * free to drift.
 */
export async function resolveMailOwner(
  hostname: string,
): Promise<Extract<SslOwner, { kind: "mail" }> | null> {
  const base = hostname.trim().toLowerCase().replace(/^mail\./, "");
  if (base === hostname.trim().toLowerCase()) return null; // not a mail.<base> host
  const mail = await repos.mailServer.findByDomain(base).catch(() => undefined);
  if (!mail) return null;
  const server = await repos.server.get(mail.serverId).catch(() => undefined);
  if (!server?.organizationId) return null;
  return { kind: "mail", serverId: mail.serverId, organizationId: server.organizationId };
}

/** The "must be verified first" gate. A helper rather than a hoisted check
 *  because each owner branch runs it at its OWN position relative to the other
 *  per-branch checks — moving it earlier would change that precedence. */
function assertVerified(domainRecord: Domain, opts: DomainSslOptions): void {
  if (!opts.allowUnverified && !domainRecord.verified) {
    throw new ForbiddenError("Domain must be verified before SSL can be managed");
  }
}

async function resolveAuthorizedDomain(hostname: string, opts: DomainSslOptions) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  // A mail-owned row has no project, so the project lookup below would reject it
  // outright — which is how the mail certificate ended up with no renewal path.
  // It is NOT waved through: it still has to resolve to a real mail server and a
  // real organization, and `opts.projectId` (the defence-in-depth project scope)
  // can never match a project-less row, so a caller passing one is refused.
  if (domainRecord.ownerType === MAIL_DOMAIN_OWNER) {
    if (opts.projectId) throw new NotFoundError("Domain", hostname);
    assertVerified(domainRecord, opts);
    const owner = await resolveMailOwner(domainRecord.hostname);
    if (!owner) throw new NotFoundError("Domain", hostname);
    return { domainRecord, owner: owner as SslOwner };
  }

  const project = await repos.project.findById(domainRecord.projectId);
  if (!project) throw new NotFoundError("Domain", hostname);

  // Access verification is enforced at the route boundary
  // (requirePermission middleware checks org membership before the
  // controller runs). The optional projectId is a defense-in-depth scope.
  if (opts.projectId && domainRecord.projectId !== opts.projectId) {
    throw new NotFoundError("Domain", hostname);
  }

  assertVerified(domainRecord, opts);

  return { domainRecord, owner: { kind: "project", project } as SslOwner };
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
 *   - no cert BY DESIGN      → null (TLS is issued elsewhere; "provisioning" would
 *                              overwrite a correct "external" and make the UI show
 *                              a cert lifecycle nobody is driving)
 *   - cert genuinely missing → "provisioning" (still being issued)
 */
export function resolveSslPatch(
  currentStatus: string | null | undefined,
  result: SslResult,
): { sslStatus: string; sslIssuer?: string; sslExpiresAt?: Date } | null {
  if (result.reason === "not_local") return null;
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

/**
 * The result for "we didn't issue anything, and that's correct".
 *
 * `verified: true` because from the caller's point of view TLS for this hostname is
 * handled — the wizard should show success, not a failure it can't act on. No
 * `expiresAt`, because we don't own that cert's lifecycle and must not claim to.
 */
function notLocalResult(hostname: string): SslResult {
  return { domain: hostname, expiresAt: "", issuer: "", verified: true, reason: "not_local" };
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
 * Put a mail server's `mail.<base>` certificate on the renewer's list.
 *
 * The mail certificate is issued through `platform.ssl` like every other one, but a
 * mail server has no project and so had no row in `domain` — which is the table
 * `renewExpiringCerts` reads. The result was a certificate that worked perfectly
 * and then expired ~90 days after install, silently, with nothing to renew it.
 * (On a bare box the distro's certbot package shipped a `certbot.timer` that
 * covered this by accident; a containerized edge has no such timer, and the host
 * certbot it relied on is gone.) This row is what closes that.
 *
 * `verified: true` because a completed ACME issuance IS proof the hostname resolves
 * to this box and :80 is reachable — the same reasoning self-hosted custom-domain
 * verification relies on. Idempotent: re-running step 12 refreshes the expiry.
 *
 * Best-effort by contract. Bookkeeping must never fail an install step that already
 * succeeded — the certificate is on disk either way, and a missed row is recoverable
 * by re-running the step, whereas a failed step is not.
 */
export async function recordMailCertDomain(
  hostname: string,
  result: SslResult,
): Promise<void> {
  try {
    const row = await repos.domain.findOrCreate({
      hostname,
      ownerType: MAIL_DOMAIN_OWNER,
      domainType: "custom",
      status: "active",
      verified: true,
    });
    // Someone already owns this hostname as a project/webhook domain. Leave it
    // alone: stamping mail's cert onto it would mis-attribute the row, and that
    // owner's own SSL lifecycle is already driving it.
    if (row.ownerType !== MAIL_DOMAIN_OWNER) {
      console.warn(
        `[MAIL] ${hostname} is already registered as a ${row.ownerType} domain — ` +
          `not recording the mail certificate against it.`,
      );
      return;
    }
    await persistSslResult(row.id, row.sslStatus, result);
  } catch (err) {
    console.warn(
      `[MAIL] could not record the certificate for ${hostname} — renewal may not be ` +
        `scheduled until step 12 is re-run: ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Bookkeeping recovery for an issuance attempt that THREW: ask the disk what
 * happened instead of believing the exception.
 *
 * A throw is not proof that no certificate was issued. The ACME order can complete
 * and a step AFTER it fail — the vhost rewrite, the reload, or the post-issue read
 * of `live/<domain>` itself. When that happens the persist is skipped, so the row
 * keeps `sslStatus: "provisioning"` and a NULL `sslExpiresAt` — and the renewal
 * sweep keys off both (`renewOrgCerts` skips anything not active with an expiry).
 * Renewal therefore never fires while a perfectly valid certificate sits on the
 * edge counting down: TLS expires ~90 days later, silently, with the UI showing a
 * domain that looks like it never got a cert at all.
 *
 * A read-only re-read settles it. A COMFORTABLY valid cert can only have come from
 * the run that just threw — every caller re-checks before issuing and proceeds only
 * when the cert is missing, near expiry, or forced — so it IS the outcome: persist
 * it and return it. Anything less (nothing on disk, or the near-expiry cert we were
 * trying to replace) means the failure was real, so rethrow untouched.
 */
async function recoverIssuedCert(
  ssl: SslProvider,
  domainRecord: { id: string; hostname: string; sslStatus?: string | null },
  err: unknown,
): Promise<SslResult> {
  const onDisk = await ssl.verifyCert(domainRecord.hostname).catch(() => null);
  if (!onDisk || !certComfortablyValid(onDisk)) throw err;

  console.warn(
    `[SSL] ${domainRecord.hostname}: issuance reported an error but a valid certificate ` +
      `(expires ${onDisk.expiresAt.slice(0, 10)}) is present on the edge — recording it so renewal ` +
      `stays scheduled. The error was: ${safeErrorMessage(err)}`,
  );
  await persistSslResult(domainRecord.id, domainRecord.sslStatus, onDisk);
  return onDisk;
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
async function resolveSslProvider(owner: SslOwner): Promise<ResolvedSslProvider> {
  // A mail server IS the box — no deployment to resolve through, and no
  // local-host fallback to want: the cert lives on that server's edge or nowhere.
  // `lockScope` is the server id so mail issuance takes the same per-box ACME lock
  // as the apps sharing that edge (they contend for one standalone challenge port).
  if (owner.kind === "mail") {
    const resolved = await resolveDeploymentPlatform(
      { serverId: owner.serverId } as DeploymentMeta,
      { organizationId: owner.organizationId },
    );
    return { ssl: resolved.platform.ssl, lockScope: owner.serverId };
  }

  const project = owner.project;
  const depId = project.activeDeploymentId;
  if (depId) {
    const dep = await repos.deployment.findById(depId);
    if (dep) {
      const meta = (dep.meta ?? {}) as DeploymentMeta;
      try {
        const resolved = await resolveDeploymentPlatform(meta, { organizationId: dep.organizationId });
        return { ssl: resolved.platform.ssl, lockScope: meta.serverId ?? LOCAL_ACME_SCOPE };
      } catch (err) {
        // Deploy target unresolvable — fall through to the host-anchored fallback.
        // But say so with the real cause: for a REMOTE-target project (meta.serverId
        // set) the fallbacks below act on a DIFFERENT box than the one whose edge
        // serves the domain, so certbot/verify silently misfires there and the
        // operator sees an inexplicable "no cert"/525 with nothing to trace it to.
        // (For a single-box install the fallback resolves to the same local edge, so
        // this is only noise there — hence a warn, not a throw.)
        console.warn(
          `[domain-ssl] could not resolve the deployment platform for ${owner.kind === "project" ? owner.project.id : "domain"}` +
            `${meta.serverId ? ` (server ${meta.serverId})` : ""} — falling back to the host edge: ${safeErrorMessage(err)}`,
        );
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
        return { ssl: resolved.platform.ssl, lockScope: local.id };
      } catch (err) {
        // Host-server unresolvable — last resort below.
        console.warn(
          `[domain-ssl] could not resolve the local host-server (${local.id}) edge — ` +
            `falling back to the API's own context: ${safeErrorMessage(err)}`,
        );
      }
    }
  }
  // Last resort: the API's OWN platform. This is correct only for a single-box
  // bare install where the API IS the edge host; for a containerized API or a
  // takeover'd/remote-target project it points at an edge that does not serve this
  // domain, so certbot/verify runs against the wrong (or a non-existent) edge and
  // the SSL action fails with no obvious cause. Left non-throwing so the single-box
  // case still works, but logged so the misfire is traceable when it isn't that.
  console.warn(
    `[domain-ssl] resolving SSL via the API's own edge context (last resort) for ` +
      `${owner.kind === "project" ? owner.project.id : "domain"} — if this instance's edge runs ` +
      `elsewhere (containerized API, remote deploy target, or a post-takeover host), this action ` +
      `may not reach the edge that serves the domain.`,
  );
  return { ssl: platform().ssl, lockScope: LOCAL_ACME_SCOPE };
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
// timeout. Toolchain install lives in the DEPLOY step chain instead. The first
// deploy prepares it for every local-certbot custom route, including a pending
// one whose certificate issuance is deferred until verification. This
// on-demand path can therefore issue/renew later without requiring a redeploy.
//
// EXACTLY ONE hostname per call. This used to take `includeWww` and issue the
// sibling's certificate in the same call — unguarded, so a www failure threw
// AFTER the apex had already succeeded and the caller reported the apex as
// broken. `www.<apex>` is its own domain row with its own verification, DNS
// record and certificate; callers that want both ask twice and report both.
export async function manageDomainSsl(
  hostname: string,
  opts: DomainSslOptions,
): Promise<SslResult> {
  const { domainRecord, owner } = await resolveAuthorizedDomain(hostname, opts);

  // THE gate, and it lives here rather than in each caller: this is the single
  // entrypoint that can open an ACME order (manual Provision/Verify, the ssl:renew
  // scheduler, the self-app edge provisioner, the boot reconcile), and it used to
  // run certbot for whatever hostname it was handed. Every caller was expected to
  // know not to ask — so the gate belongs where the row is already loaded.
  //
  // `verify` is exempt: it's a read-only inspection of whatever cert is on disk,
  // which is exactly what you want for an uploaded one.
  const elsewhere = opts.action === "verify" ? null : tlsIssuedElsewhere(domainRecord);
  if (elsewhere) {
    // Deliberately NOT persisted: there is nothing new to record, and writing a
    // status here would overwrite a correct `external` with `provisioning`.
    return notLocalResult(domainRecord.hostname);
  }

  const { ssl, lockScope } = await resolveSslProvider(owner);
  // `verify` is a read-only cert inspection (no ACME) → no lock. `provision`/
  // `renew` can open an ACME order, so serialize them per-hostname on the shared
  // issue lock — this is what stops the ssl:renew scheduler (which calls us with
  // action:"renew") from racing a manual Verify on the same domain — and then on
  // the per-box ACME lock, which stops it racing a DIFFERENT hostname for the
  // shared standalone challenge port.
  if (opts.action === "verify") {
    const result = await executeSslAction(ssl, domainRecord.hostname, opts.action);
    await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);
    return result;
  }

  try {
    const result = await createProvisionLock(sslIssueLockKey(domainRecord.hostname)).run(() =>
      createProvisionLock(acmeIssueLockKey(lockScope)).run(() =>
        executeSslAction(ssl, domainRecord.hostname, opts.action),
      ),
    );
    await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);
    return result;
  } catch (err) {
    // Issuance may have succeeded and a LATER step failed — never leave a valid
    // cert unrecorded. See {@link recoverIssuedCert}. Rethrows when it really failed.
    return recoverIssuedCert(ssl, domainRecord, err);
  }
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
  const { domainRecord, owner } = await resolveAuthorizedDomain(hostname, {
    action: "provision",
    projectId: opts.projectId,
    allowUnverified: true,
  });
  const { ssl, lockScope } = await resolveSslProvider(owner);

  // Serialize issuance per-hostname, and re-check the cert INSIDE the lock.
  // This closes the TOCTOU: two concurrent Verify hits (or Verify racing the
  // renewal scheduler) both queue on the lock; the first issues, and the second
  // — now inside the lock — sees the freshly-issued cert and reuses it instead
  // of opening a second ACME order. The service-level fast-path in verifyDomain
  // is only a cheap read-only optimization; THIS is the authoritative gate.
  //
  // The nested per-box lock covers the OTHER collision: a different hostname on
  // the same box (the www sibling, the pending-SSL sweep) running certbot at the
  // same time and losing the race for the shared standalone port.
  try {
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
      return createProvisionLock(acmeIssueLockKey(lockScope)).run(() =>
        ssl.provisionCert(domainRecord.hostname, { onLog: opts.onLog, force: true }),
      );
    });

    await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);
    return result;
  } catch (err) {
    // This is the path that lost TLS: a cert was issued, the post-issue read threw,
    // and the row stayed `provisioning`/null-expiry — invisible to the renewer. See
    // {@link recoverIssuedCert}. Rethrows when issuance really failed, so the caller
    // still surfaces the summarized certbot cause.
    const recovered = await recoverIssuedCert(ssl, domainRecord, err);
    opts.onLog?.(
      `A valid certificate for ${domainRecord.hostname} is present on the edge (expires ` +
        `${recovered.expiresAt.slice(0, 10)}) — recorded it, renewal is scheduled.`,
    );
    return recovered;
  }
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
  const { domainRecord, owner } = await resolveAuthorizedDomain(hostname, {
    action: "provision",
    projectId: opts.projectId,
    allowUnverified: opts.allowUnverified,
  });
  const { ssl } = await resolveSslProvider(owner);
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
  const { domainRecord, owner } = await resolveAuthorizedDomain(hostname, {
    action: "verify",
    projectId: opts.projectId,
    allowUnverified: true,
  });
  const { ssl } = await resolveSslProvider(owner);
  const result = await ssl.verifyCert(domainRecord.hostname);
  await persistSslResult(domainRecord.id, domainRecord.sslStatus, result);
  return result;
}
