/**
 * Pre-deploy checks - validate prerequisites before the build pipeline starts.
 *
 * Called after the user clicks Deploy but BEFORE any build work begins.
 * If any check fails, the deployment is rejected with actionable errors -
 * no resources are provisioned, no build session started.
 *
 * Cloud checks are SaaS-owned:
 *   - SaaS mode calls the shared cloud preflight service directly
 *   - Desktop/local mode calls the SaaS preflight endpoint
 *   - Local/desktop never talks to Oblien directly for preflight
 */

import type { DeploymentConfigSnapshot } from "./build.service";
import { platform } from "../../lib/controller-helpers";
import {
  resolveEffectiveTarget,
  usesManagedRouting as usesManagedRoutingFor,
} from "../../lib/deployment-runtime";
import { resolveServiceHostnameLabel, normalizeCustomHostname } from "@repo/core";
import { cloudClient } from "../../lib/cloud/client";
import { isCloudConnectedForOrg } from "../../lib/cloud/session";
import { runCloudPreflight, type CloudPreflightData } from "../../lib/cloud-preflight";
import { isStaticService, type DeployableService } from "../../lib/deployable-service";
import { serviceKind } from "./compose/project-services";
import { resolveClonePlan } from "./clone-plan";
import { isPublicRepo } from "../github/github.http";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { resolveServerHost } from "../../lib/server-target";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import {
  getInstallationId,
  getInstallationIdByOrg,
  getGitHubAuthMode,
  getInstallUrl,
  resolveGitHubAuthMode,
} from "../github/github.auth";
import { canResolveTokenFor } from "../github/github.token";
import { canResolveServerGitCredential } from "../github/server-github.service";
import { parseRepoUrl } from "../github/github.service";
import { resolveRecords, lookupAddresses } from "../../lib/dns-resolver";
import { type RequestContext } from "../../lib/request-context";
import { repos } from "@repo/db";

/**
 * Hostnames this project already holds on the routing edge, so a redeploy
 * reclaiming one of them is NOT a conflict (the availability check exists to
 * catch collisions with OTHER projects). Gated on `activeDeploymentId`: domain
 * rows are written at project create/config time (persistProjectRouteState),
 * so their mere existence does NOT mean the slug was claimed — only a project
 * that has actually deployed owns its routes on the edge. A never-deployed
 * project therefore still runs the real availability check (no first-deploy
 * conflict masking). Best-effort: any lookup failure yields an empty set, so
 * the availability check runs.
 */
async function projectLiveHostnames(projectId: string | undefined): Promise<Set<string>> {
  if (!projectId) return new Set();
  try {
    const project = await repos.project.findById(projectId);
    if (!project?.activeDeploymentId) return new Set();
    const domains = await repos.domain.listByProject(projectId);
    return new Set(domains.map((d) => d.hostname.toLowerCase()));
  } catch {
    return new Set();
  }
}

export interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  code?: string;
}

export const PREFLIGHT_ERROR_CODES = {
  CLOUD_REQUIRED_TARGET: "CLOUD_REQUIRED_TARGET",
  /** Org IS cloud-connected (owner's session validates) but the SaaS
   *  preflight call returned nothing — transient (5xx / network). Distinct
   *  from CLOUD_REQUIRED_TARGET so we never tell a connected user to
   *  "connect your account" over a momentary blip. */
  CLOUD_UNREACHABLE: "CLOUD_UNREACHABLE",
  CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN: "CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN",
  CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS: "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS",
  GITHUB_APP_INSTALLATION_REQUIRED: "GITHUB_APP_INSTALLATION_REQUIRED",
  REMOTE_BUILD_TOKEN_LEAK_RISK: "REMOTE_BUILD_TOKEN_LEAK_RISK",
  /** gh CLI auth + remote-server build target. clone-auth.ts will throw
   *  GITHUB_CLI_REMOTE_BUILD_REJECTED at deploy time — surface it earlier
   *  so the user can fix it before provisioning starts. */
  GITHUB_CLI_REMOTE_BUILD_REJECTED: "GITHUB_CLI_REMOTE_BUILD_REJECTED",
  /** No remote-safe clone token resolvable for the project's owner.
   *  Atomic — same `tokenFor(purpose:"remote")` resolver that clone-auth
   *  uses at deploy time. Failing here surfaces the missing-credential
   *  modal up-front instead of letting the build pipeline fail later. */
  GITHUB_REMOTE_TOKEN_REQUIRED: "GITHUB_REMOTE_TOKEN_REQUIRED",
} as const;

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  customDomain?: string;
  slug?: string;
  /** Foreground/background request context — the single carrier of the
   *  authenticated identity (userId + organizationId) for every check that
   *  needs it (GitHub auth, cloud bridge). Callers MUST pass this. */
  ctx?: RequestContext;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  composeServices?: DeployableService[];
  multiService?: boolean;
  /** Git owner (org / user) for the project's source repo. When the
   *  deployment targets cloud, we check that the GitHub App is installed
   *  on this owner - otherwise the build will fail with a token error
   *  AFTER provisioning resources. Catching it here surfaces a clear
   *  "install the App on <owner>" message and skips the wasted work. */
  gitOwner?: string | null;
  /** Git repo name — with `gitOwner`, lets preflight probe whether the repo is
   *  PUBLIC and, if so, skip the credential checks (a public repo clones with
   *  no auth). Falls back to parsing the snapshot's repoUrl when omitted. */
  gitRepo?: string | null;
  /** Project id — passed to `tokenFor` so per-project clone tokens are
   *  considered as a valid remote-clone source. Optional because the
   *  project row may not exist yet during a first-deploy preflight. */
  projectId?: string;
  /** Whether the build runs on the API host (`local`) or on the deploy
   *  target (`server`). For non-App auth modes, only `local` keeps the
   *  user's broad-scope token from leaving the API process. */
  buildStrategy?: "local" | "server";
}

/** Resolve owner/repo for the public-ness probe: prefer the already-parsed
 *  hints, else fall back to the shared GitHub URL parser. */
function parseGithubOwnerRepo(
  repoUrl?: string,
  ownerHint?: string | null,
  repoHint?: string | null,
): { owner: string; repo: string } | null {
  if (ownerHint && repoHint) return { owner: ownerHint, repo: repoHint };
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;
  return { owner: ownerHint || parsed.owner, repo: parsed.repo };
}

/**
 * Check the GitHub App is installed for the project's owner. Cloud builds
 * REQUIRE an installation token (no OAuth fallback - sending a long-lived
 * user-scope token to cloud infra would be too broad). If the owner has
 * no installation row, every cloud build for this project will fail with
 * a 403 from `resolveBuildGitToken`. Catch it in preflight so the user
 * sees an actionable message + the install URL.
 */
async function checkGitHubAppInstallation(
  ctx: RequestContext | null,
  owner: string | null | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "github-app-installation",
    label: "GitHub App access",
  };
  if (!ctx) {
    return { ...baseCheck, status: "warn", message: "User session missing - skipping check." };
  }
  if (!owner) {
    return { ...baseCheck, status: "pass" };
  }
  // Per-user mode resolution — picks "cloud-app" on self-hosted +
  // cloud-connected. Both App-scoped modes need an installation on
  // the owner; cli / oauth / token modes don't (they use the user's
  // own credentials, not installation-scoped tokens).
  const mode = await resolveGitHubAuthMode(ctx);
  if (mode !== "app" && mode !== "cloud-app") {
    return { ...baseCheck, status: "pass" };
  }
  // Mirror tokenFor: prefer org-scoped installation row, fall back to
  // the per-user row.
  let installationId: number | null = null;
  if (ctx.organizationId) {
    installationId = await getInstallationIdByOrg(ctx.organizationId, owner).catch(() => null);
  }
  if (!installationId) {
    installationId = await getInstallationId(ctx, owner).catch(() => null);
  }
  if (installationId) {
    return { ...baseCheck, status: "pass" };
  }
  return {
    ...baseCheck,
    status: "fail",
    code: PREFLIGHT_ERROR_CODES.GITHUB_APP_INSTALLATION_REQUIRED,
    message:
      `The Openship GitHub App is not installed on "${owner}". ` +
      `Deploys need it to mint a scoped token for cloning the repo. ` +
      `Install it at ${getInstallUrl()} and deploy again.`,
  };
}

/**
 * Warn when a deploy will ship the user's broad-scope token to a remote
 * build worker. This happens specifically when:
 *
 *   - The API runs in a non-App mode (oauth / cli / token) - no short-lived
 *     installation token exists to mint.
 *   - The build runs on the deploy target (`buildStrategy === "server"`),
 *     not on the API host - so the token has to travel.
 *   - The deploy target is remote (not the same host as the API).
 *
 * In that combination, today we ship the OAuth / gh / static PAT to the
 * remote target as `x-access-token` for clone. That token has access to
 * the user's entire GitHub footprint. A future phase will route this via
 * API-proxied clone + tarball ship so no token leaves the API process.
 * Until then, this preflight check surfaces the trade-off and recommends
 * switching to `buildStrategy=local` (which is already safe).
 */
async function checkRemoteBuildTokenLeak(
  ctx: RequestContext | null,
  effectiveTarget: string,
  buildStrategy: "local" | "server" | undefined,
  serverId: string | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "remote-build-token",
    label: "Remote build credential",
  };
  // Per-user resolution so cloud-app (self-hosted + cloud-connected)
  // gets recognised as App-scoped. Fall back to sync resolution when
  // no ctx is available (e.g. preflight invoked from a CLI tool).
  const mode = ctx ? await resolveGitHubAuthMode(ctx) : getGitHubAuthMode();
  // App-scoped modes (local-signed or cloud-proxied) already use
  // short-lived installation tokens — safe to ship to a remote build.
  if (mode === "app" || mode === "cloud-app") return { ...baseCheck, status: "pass" };
  if (buildStrategy === "local") return { ...baseCheck, status: "pass" };
  if (effectiveTarget === "cloud") return { ...baseCheck, status: "pass" };
  // A per-server credential means the clone authenticates as the SERVER, not by
  // shipping the operator's gh-cli token off-host — so the leak concern (and the
  // cli hard-fail below) doesn't apply.
  if (serverId && (await canResolveServerGitCredential(serverId).catch(() => false))) {
    return { ...baseCheck, status: "pass" };
  }

  // gh CLI tokens are the user's personal long-lived PAT. clone-auth.ts
  // hard-refuses these on remote builds (GITHUB_CLI_REMOTE_BUILD_REJECTED).
  // Surface that here so the user fixes it BEFORE provisioning starts.
  if (mode === "cli") {
    return {
      ...baseCheck,
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.GITHUB_CLI_REMOTE_BUILD_REJECTED,
      message:
        `gh CLI auth only works for local builds. ` +
        `Connect the Openship App in Settings → GitHub, or set a per-project ` +
        `clone token, then deploy again.`,
    };
  }

  // Other non-App modes (oauth / static token) — ship-the-token risk
  // is the user/operator's explicit choice. Warn but don't refuse.
  return {
    ...baseCheck,
    status: "warn",
    code: PREFLIGHT_ERROR_CODES.REMOTE_BUILD_TOKEN_LEAK_RISK,
    message:
      `Building on the remote target will ship your GitHub credential there. ` +
      `Switch to "Build on this machine" (buildStrategy=local) to keep the token ` +
      `on the API host, or install the GitHub App to mint short-lived per-repo tokens.`,
  };
}

/**
 * Atomic remote-clone-token check. The single source of truth for
 * "can this deploy actually clone the repo on the build worker?" — runs
 * the same `tokenFor(userId, "remote", ...)` resolver clone-auth uses at
 * deploy time, but non-throwing.
 *
 * Skipped when:
 *   - no userId / no owner (nothing to resolve)
 *   - buildStrategy === "local" (clone happens on the API host, not remote)
 *   - effectiveTarget === "local" (no remote at all)
 *
 * On fail, emits GITHUB_REMOTE_TOKEN_REQUIRED — the dashboard maps that
 * code to DeployCredentialModal (install App / add PAT /
 * build locally). This subsumes the per-mode App-installation check
 * for the remote-clone case but we keep `checkGitHubAppInstallation`
 * for clearer error copy when the App is configured but uninstalled.
 */
async function checkRemoteCloneToken(
  ctx: RequestContext | null,
  owner: string | null | undefined,
  projectId: string | undefined,
  effectiveTarget: string,
  buildStrategy: "local" | "server" | undefined,
  serverId: string | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "remote-clone-token",
    label: "Remote clone credential",
  };
  if (!ctx || !owner) return { ...baseCheck, status: "pass" };
  if (buildStrategy === "local") return { ...baseCheck, status: "pass" };
  if (effectiveTarget === "local") return { ...baseCheck, status: "pass" };

  // A per-server GitHub credential (device token / PAT / SSH key) satisfies the
  // clone directly — check it FIRST (matches clone-auth's precedence).
  if (serverId && (await canResolveServerGitCredential(serverId).catch(() => false))) {
    return { ...baseCheck, status: "pass" };
  }

  // Existence check only — no mint. The real mint happens later in the
  // build pipeline when we actually need to clone.
  const source = await canResolveTokenFor(ctx, "remote", {
    projectId,
    owner,
  }).catch(() => null);
  if (source) return { ...baseCheck, status: "pass" };

  return {
    ...baseCheck,
    status: "fail",
    code: PREFLIGHT_ERROR_CODES.GITHUB_REMOTE_TOKEN_REQUIRED,
    message:
      `No GitHub credential available to clone "${owner}" onto the build worker. ` +
      `Install the Openship App on this owner, add a per-project clone token, ` +
      `or switch to "Build on this machine" so the credential stays on the API host.`,
  };
}

/**
 * Clone-on-server credential check (DOCKER opt-in, `cloneStrategy === "server"`).
 *
 * Unlike bare (which hard-fails without a remote credential — see
 * `checkRemoteCloneToken`), docker gracefully falls back to cloning on the API
 * host + transfer when no shippable credential exists. So a missing credential
 * here is a WARN, not a failure: it tells the user the deploy will fall back.
 *
 *   - desktop → the git-credential relay (reverse tunnel; nothing persisted).
 *     Opened at deploy time; if the server's SSH auth can't host it the pipeline
 *     warns + falls back. Nothing to verify up-front — pass.
 *   - non-desktop → a short-lived token is shipped to the server. Same
 *     `tokenFor(purpose:"remote")` resolver clone-auth uses; existence-only.
 */
async function checkCloneOnServerCredential(
  ctx: RequestContext | null,
  owner: string | null | undefined,
  projectId: string | undefined,
  platformTarget: string,
  serverId: string | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "clone-on-server",
    label: "Clone-on-server credential",
  };
  if (platformTarget === "desktop") {
    // Desktop default: clone on the server via the forwarded git identity (used
    // for the build only, never stored). Opting out clones here + transfers —
    // either way this never blocks, so it's an informational pass.
    return {
      ...baseCheck,
      status: "pass",
      message:
        "Will clone on the server using your forwarded git identity (used for this build only, never stored), or clone here and transfer if you opt out.",
    };
  }
  if (!ctx || !owner) return { ...baseCheck, status: "pass" };

  // A per-server GitHub credential clones directly on the server — satisfies
  // this check outright.
  if (serverId && (await canResolveServerGitCredential(serverId).catch(() => false))) {
    return { ...baseCheck, status: "pass" };
  }

  const source = await canResolveTokenFor(ctx, "remote", {
    projectId,
    owner,
  }).catch(() => null);
  if (source) return { ...baseCheck, status: "pass" };

  return {
    ...baseCheck,
    status: "warn",
    message:
      `"Clone on the server" is selected, but no GitHub credential is available to ship to the build host. ` +
      `The deploy will fall back to cloning on the API host and transferring the context. ` +
      `Install the Openship App on "${owner}" or add a per-project clone token to clone directly on the server.`,
  };
}

/**
 * A cloud lookup deferred from the sync validation pass so they can all run
 * in parallel: either a custom-domain DNS check or a free-subdomain
 * availability check, tied back to its endpoint by index.
 */
type EndpointCloudLookup =
  | { kind: "custom"; index: number; label: string; hostname: string }
  | { kind: "slug"; index: number; label: string; slug: string };

/**
 * Validate every declared public endpoint before the build runs.
 *
 * Each endpoint maps a public hostname (a free `<slug>.<baseDomain>` or a
 * custom domain) to exactly one target — a port (server deploys) or a
 * static path (static/cloud deploys). We surface ALL problems at once
 * (accumulate, don't fail-fast) so the user fixes everything in one pass.
 *
 * Structure:
 *   Pass 1 — synchronous, deterministic: shape + format validation and
 *            hostname de-duplication (order matters for "first wins", so it
 *            stays sequential). Records the cloud lookup each surviving
 *            endpoint still needs.
 *   Pass 2 — the recorded cloud lookups (slug availability / custom-domain
 *            DNS) run CONCURRENTLY. Previously these were awaited one-per-
 *            endpoint inside the loop — O(n) serial SaaS round-trips.
 */
async function checkPublicEndpoints(
  snapshot: DeploymentConfigSnapshot,
  endpoints: NonNullable<PreflightOptions["publicEndpoints"]>,
  cloud: CloudPreflightData | null,
  ctx?: RequestContext,
  projectId?: string,
): Promise<PreflightCheck[]> {
  const plat = platform();
  const effectiveTarget = resolveEffectiveTarget(plat.target, snapshot);
  const isCloudStatic = effectiveTarget === "cloud" && !snapshot.hasServer;
  // Whether we can reach the SaaS to verify slugs / custom domains.
  const canBridgeCloud = Boolean(cloud?.runtime.ok && ctx?.userId);
  const baseDomain = getRoutingBaseDomain();

  const checks: PreflightCheck[] = [];
  const fail = (id: string, label: string, message: string): PreflightCheck => ({
    id,
    label,
    status: "fail",
    message,
  });

  // Collection-level rule: a cloud static deploy supports at most one
  // explicit path-targeted endpoint.
  if (
    isCloudStatic &&
    endpoints.filter((e) => typeof e.targetPath === "string").length > 1
  ) {
    checks.push(
      fail(
        "endpoint-static-cloud-shape",
        "Static endpoint routing",
        "Cloud static deployments currently support only one explicit path-targeted public endpoint.",
      ),
    );
  }

  // ── Pass 1: sync shape/format validation + dedup (ids keyed by index so
  //    two endpoints with the same target label can't collide). ──
  const seenHostnames = new Set<string>();
  const lookups: EndpointCloudLookup[] = [];

  endpoints.forEach((endpoint, index) => {
    const normalizedTargetPath = normalizeTargetPath(endpoint.targetPath);
    const hasPortTarget = endpoint.port !== undefined;
    const hasPathTarget = Boolean(normalizedTargetPath);
    const label = hasPathTarget
      ? normalizedTargetPath!
      : endpoint.port != null
        ? String(endpoint.port)
        : "unknown";
    const idOf = (suffix: string) => `endpoint-${index}-${suffix}`;

    // Exactly one of {port, path}.
    if (hasPortTarget === hasPathTarget) {
      checks.push(
        fail(
          idOf("target"),
          `Endpoint target (${label})`,
          "Each endpoint must target exactly one destination: either a port or a static path.",
        ),
      );
      return;
    }

    if (hasPortTarget) {
      const port = endpoint.port as number;
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        checks.push(
          fail(idOf("port"), `Endpoint port (${label})`, "Port must be between 1 and 65535."),
        );
      }
    }

    // Target kind must match the deployment kind.
    if (hasPortTarget && !snapshot.hasServer) {
      checks.push(
        fail(
          idOf("shape"),
          `Endpoint target (${label})`,
          "Static deployments cannot expose port-targeted routes. Use a static target path instead.",
        ),
      );
    } else if (hasPathTarget && snapshot.hasServer) {
      checks.push(
        fail(
          idOf("shape"),
          `Endpoint target (${label})`,
          "Server deployments must expose port-targeted routes. Static target paths are only valid for static deployments.",
        ),
      );
    }

    // Domain — custom hostname or free subdomain. Defer the network check
    // (DNS / availability) to the parallel pass below.
    if (endpoint.domainType === "custom") {
      // Same canonical form storage/routing use, so the DNS/availability probe
      // checks the host that will actually be deployed (not a scheme-dressed
      // form the user may have typed into an unpersisted wizard proposal).
      const hostname = endpoint.customDomain ? normalizeCustomHostname(endpoint.customDomain) : "";
      if (!hostname) {
        checks.push(
          fail(idOf("domain"), `Endpoint domain (${label})`, "Custom endpoint domains cannot be empty."),
        );
        return;
      }
      if (seenHostnames.has(hostname)) {
        checks.push(
          fail(idOf("domain"), `Endpoint domain (${label})`, `Duplicate domain configured: ${hostname}`),
        );
        return;
      }
      seenHostnames.add(hostname);
      lookups.push({ kind: "custom", index, label, hostname });
      return;
    }

    const slug = endpoint.domain?.trim().toLowerCase();
    if (!slug) {
      checks.push(
        fail(idOf("slug"), `Endpoint subdomain (${label})`, "Free endpoint subdomains cannot be empty."),
      );
      return;
    }
    checks.push({
      ...checkSlugFormat(slug),
      id: idOf("slug"),
      label: `Endpoint subdomain (${label})`,
    });
    const hostname = `${slug}.${baseDomain}`;
    if (seenHostnames.has(hostname)) {
      checks.push(
        fail(idOf("domain"), `Endpoint domain (${label})`, `Duplicate domain configured: ${hostname}`),
      );
      return;
    }
    seenHostnames.add(hostname);
    // Availability is only verifiable when we can bridge to the SaaS.
    if (canBridgeCloud) lookups.push({ kind: "slug", index, label, slug });
  });

  // Subdomains this project already holds live — fetched once, not per endpoint.
  const ownedLive = await projectLiveHostnames(projectId);

  const resolved = await Promise.all(
    lookups.map(async (lk): Promise<PreflightCheck> => {
      if (lk.kind === "custom") {
        // Per-endpoint cloud preflight only when we can bridge; otherwise
        // fall back to the shared `cloud` result (self-hosted CNAME path).
        const endpointCloud = canBridgeCloud
          ? await requestCloudPreflight(snapshot, { customDomain: lk.hostname })
          : cloud;
        const result = await checkCustomDomain(lk.hostname, endpointCloud, snapshot);
        return { ...result, id: `endpoint-${lk.index}-domain`, label: `Endpoint domain (${lk.label})` };
      }
      // Redeploy reclaiming a subdomain this project already holds live is not
      // a conflict — skip the cloud availability probe entirely for it.
      if (ownedLive.has(`${lk.slug}.${baseDomain}`.toLowerCase())) {
        return {
          id: `endpoint-${lk.index}-availability`,
          label: `Endpoint availability (${lk.label})`,
          status: "pass",
        };
      }
      const endpointCloud = await requestCloudPreflight(snapshot, { slug: lk.slug });
      const availability = await checkSlug(lk.slug, endpointCloud);
      return {
        ...availability,
        id: `endpoint-${lk.index}-availability`,
        label: `Endpoint availability (${lk.label})`,
      };
    }),
  );
  checks.push(...resolved);

  return checks;
}

async function checkComposeServiceDomains(
  composeServices: DeployableService[],
  projectSlug: string | undefined,
  cloud: CloudPreflightData | null,
  snapshot?: DeploymentConfigSnapshot,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const seen = new Set<string>();
  const baseDomain = getRoutingBaseDomain();

  for (const service of composeServices) {
    if (!service.exposed) continue;

    if (service.domainType === "custom" && service.customDomain?.trim()) {
      const domain = normalizeCustomHostname(service.customDomain);
      if (seen.has(domain)) {
        checks.push({
          id: `service-domain-${service.name}`,
          label: `Service domain (${service.name})`,
          status: "fail",
          message: `Duplicate custom domain configured: ${domain}`,
        });
        continue;
      }
      seen.add(domain);

      const result = await checkCustomDomain(domain, cloud, snapshot);
      checks.push({
        ...result,
        id: `service-domain-${service.name}`,
        label: `Service domain (${service.name})`,
      });
      continue;
    }

    const subdomain = resolveServiceHostnameLabel(
      projectSlug || "project",
      service.name,
      service.domain,
      serviceKind(service),
    );
    const fqdn = `${subdomain}.${baseDomain}`;

    // Free subdomains require cloud - fail early if not connected
    if (!cloud) {
      checks.push({
        id: `service-domain-${service.name}`,
        label: `Service subdomain (${service.name})`,
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS,
        message: `Free subdomain "${fqdn}" requires Openship Cloud. Connect your account or switch to a custom domain.`,
      });
      continue;
    }

    if (seen.has(fqdn)) {
      checks.push({
        id: `service-domain-${service.name}`,
        label: `Service domain (${service.name})`,
        status: "fail",
        message: `Duplicate service subdomain configured: ${subdomain}`,
      });
      continue;
    }
    seen.add(fqdn);

    const result = checkSlugFormat(subdomain);
    checks.push({
      ...result,
      id: `service-domain-${service.name}`,
      label: `Service subdomain (${service.name})`,
    });
  }

  return checks;
}

async function requestCloudPreflight(
  snapshot: DeploymentConfigSnapshot,
  input: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData | null> {
  const plat = platform();
  if (!snapshot.organizationId) return null;

  // On the SaaS itself, run preflight in-process — no bridge needed.
  // `runCloudPreflight` keys EVERYTHING off the organization id
  // (namespace slug, quota, token mint) — passing userId here used
  // to mint the wrong namespace on SaaS.
  if (plat.target === "cloud") {
    return runCloudPreflight(snapshot.organizationId, input);
  }

  // Everywhere else (selfhosted, desktop): bridge to SaaS via the
  // stored bearer. The token IS the source of truth — if it's valid
  // SaaS answers, if not the bridge returns null and the outer code
  // surfaces "connect your account". No second-guessing at this
  // layer.
  return cloudClient({ organizationId: snapshot.organizationId }).preflight(input);
}

async function resolveCloudPreflight(
  snapshot: DeploymentConfigSnapshot,
  opts?: PreflightOptions,
): Promise<CloudPreflightData | null> {
  const plat = platform();
  // The deploy target. On SaaS we ARE the cloud, so cloud is implicit.
  // Resolve the effective target through the single authority so this matches
  // exactly where the build pipeline will land the deploy (resolveDeploymentPlatform
  // uses the same function). buildConfigSnapshot derives deployTarget from
  // `project.cloudWorkspaceId`, the canonical "is this a cloud project" test.
  const effectiveTarget = resolveEffectiveTarget(plat.target, snapshot);

  // Managed routing = "the deploy lands on the operator's own server,
  // but the public hostname is a free .openship.io slug served by
  // cloud edge". That's the only reason a server-target deploy needs
  // to ping cloud preflight. Cloud-target deploys obviously need it
  // too (cloud IS doing the deploy). Single authority shared with the pipeline.
  const usesManagedRouting = usesManagedRoutingFor(plat.target, effectiveTarget);
  const hasManagedPublicEndpoints =
    opts?.publicEndpoints?.some((endpoint) => endpoint.domainType !== "custom") ?? false;
  // The project-level free-domain slug is a routable web hostname only for a
  // single-app project. In services mode there is no project domain — each
  // service routes via its own endpoint (needsManagedComposeDomains), so an
  // internal-only services deploy (nothing exposed, e.g. an adopted Docker
  // stack migrated to a self-hosted server) must NOT demand a managed free
  // .opsh.io domain it can't route without cloud.
  const needsManagedProjectDomain =
    (!opts?.multiService && !!opts?.slug && !opts?.customDomain && usesManagedRouting) ||
    (usesManagedRouting && hasManagedPublicEndpoints);
  const needsManagedComposeDomains =
    opts?.composeServices?.some((service) => service.exposed && service.domainType !== "custom") ??
    false;
  const needsCloudPreflight =
    effectiveTarget === "cloud" || needsManagedProjectDomain || needsManagedComposeDomains;
  const requestInput = opts?.publicEndpoints?.length
    ? {}
    : {
        slug: opts?.slug,
        customDomain: opts?.customDomain,
      };

  // Authenticated-context gate so preflight only runs for a real request
  // (anonymous callers can't bridge to SaaS). The bridge itself keys off
  // snapshot.organizationId; the user identity comes from ctx. Gating on a
  // legacy `userId` field that deploy callers no longer set was the bug
  // that made cloud preflight silently no-op → the misleading "connected
  // but unreachable" runtime check. ctx is the single source now.
  if (!needsCloudPreflight || !opts?.ctx?.userId) {
    return null;
  }

  return requestCloudPreflight(snapshot, requestInput);
}

function checkConfig(snapshot: DeploymentConfigSnapshot, opts?: PreflightOptions): PreflightCheck {
  const missing: string[] = [];

  // A folder-upload deploy has no git and no host path — its source is the
  // pre-staged upload workspace (`sourceStaged`, set by requestBuildAccess).
  // That's a valid source, so it satisfies both the source and branch checks.
  if (!snapshot.repoUrl && !snapshot.localPath && !snapshot.sourceStaged) {
    missing.push("repository URL or local path");
  }
  if (!snapshot.branch && !snapshot.localPath && !snapshot.sourceStaged) missing.push("branch");

  if (opts?.multiService) {
    // A services/compose deploy needs a project repo/localPath ONLY when some
    // enabled service builds FROM that shared source — a Dockerfile / build
    // context, or a monorepo sub-app. Registry-image services (e.g. an adopted
    // Docker stack of postgres/redis migrated in) build nothing, so no source
    // is required. We inspect the ACTUAL services rather than trusting a single
    // project-level `hasBuild` flag, which an adopted-Docker project may leave
    // unset on the snapshot even though nothing builds — the bug that made a
    // Docker migration fail preflight with "repository URL or local path".
    const enabledServices = (opts.composeServices ?? []).filter((s) => s.enabled !== false);
    const needsProjectSource =
      enabledServices.length > 0
        ? enabledServices.some((s) => s.kind === "monorepo" || !!s.build || !!s.dockerfile)
        : snapshot.hasBuild !== false;
    const serviceMissing = needsProjectSource
      ? missing
      : missing.filter((m) => m !== "repository URL or local path" && m !== "branch");
    if (serviceMissing.length > 0) {
      return {
        id: "config",
        label: "Service configuration",
        status: "fail",
        message: `Missing required fields: ${serviceMissing.join(", ")}`,
      };
    }

    // Monorepo sub-app sanity: every kind="monorepo" row with a buildable
    // shape must end up with an installCommand somewhere - either set on
    // the row itself OR inherited from the project-level snapshot. Without
    // that, the runtime synthesizes a Dockerfile that runs an empty install
    // step and fails opaquely deep into the build. Surface the missing
    // value here so the operator sees "sub-app X has no install command"
    // before resources are provisioned.
    const subAppFailures: string[] = [];
    for (const svc of opts.composeServices ?? []) {
      if (svc.kind !== "monorepo") continue;
      // Disabled sub-apps never run; skip. `enabled === false` is the
      // explicit opt-out - `exposed` is a routing concept (does the
      // sub-app get a public URL) and conflating them lets enabled-but-
      // not-exposed sub-apps slip past this check with no install command.
      if (svc.enabled === false) continue;
      if (!svc.rootDirectory) {
        subAppFailures.push(`sub-app "${svc.name}" missing rootDirectory`);
        continue;
      }
      const installFallback = svc.installCommand ?? snapshot.installCommand;
      const buildFallback = svc.buildCommand ?? snapshot.buildCommand;
      const startFallback = svc.startCommand ?? snapshot.startCommand;
      // A static sub-app is served as files by the generated nginx image, so it
      // needs a build (to produce the output dir) but NO start command.
      if (isStaticService(svc)) {
        if (!buildFallback) {
          subAppFailures.push(`sub-app "${svc.name}" missing build command`);
        }
        continue;
      }
      // hasBuild/hasServer aren't per-service today - fall back to the
      // project-level booleans on the snapshot. Conservative: if either
      // the project says it has a build OR has a server, the sub-app must
      // expose enough commands to honor that contract.
      if (snapshot.hasBuild && !installFallback) {
        subAppFailures.push(`sub-app "${svc.name}" missing install command`);
      }
      if (snapshot.hasBuild && !buildFallback) {
        subAppFailures.push(`sub-app "${svc.name}" missing build command`);
      }
      if (snapshot.hasServer && !startFallback) {
        subAppFailures.push(`sub-app "${svc.name}" missing start command`);
      }
    }
    if (subAppFailures.length > 0) {
      return {
        id: "config",
        label: "Service configuration",
        status: "fail",
        message: subAppFailures.join("; "),
      };
    }

    return { id: "config", label: "Service configuration", status: "pass" };
  }

  if (!snapshot.buildImage) missing.push("build image");

  if (snapshot.hasBuild && !snapshot.installCommand) {
    missing.push("install command");
  }

  if (snapshot.hasServer) {
    if (!snapshot.startCommand) missing.push("start command");
    if (!snapshot.port) missing.push("port");
  }

  if (missing.length > 0) {
    return {
      id: "config",
      label: "Build configuration",
      status: "fail",
      message: `Missing required fields: ${missing.join(", ")}`,
    };
  }

  return { id: "config", label: "Build configuration", status: "pass" };
}

function checkStack(snapshot: DeploymentConfigSnapshot): PreflightCheck {
  if (!snapshot.hasServer && snapshot.startCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message:
        "Static site has a start command configured - it will be ignored. Files will be served from the edge.",
    };
  }

  if (snapshot.hasBuild && !snapshot.buildCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message:
        "Build is enabled but no build command configured - deployment will use source files directly.",
    };
  }

  if (!snapshot.hasBuild && snapshot.buildCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message: "Build is disabled but a build command exists - it will be skipped.",
    };
  }

  return { id: "stack", label: "Stack configuration", status: "pass" };
}

function checkSlugFormat(slug: string): PreflightCheck {
  if (slug.length < 1 || slug.length > 63) {
    return {
      id: "slug",
      label: "Subdomain",
      status: "fail",
      message: `Slug must be between 1 and 63 characters (got ${slug.length}).`,
    };
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return {
      id: "slug",
      label: "Subdomain",
      status: "fail",
      message: `"${slug}" is not a valid subdomain. Use only lowercase letters, numbers, and hyphens. Must start and end with a letter or number.`,
    };
  }

  return { id: "slug", label: "Subdomain", status: "pass" };
}

async function checkSlug(slug: string, cloud: CloudPreflightData | null): Promise<PreflightCheck> {
  const fqdn = `${slug}.${getRoutingBaseDomain()}`;

  if (!cloud) {
    return { id: "slug-available", label: "Subdomain availability", status: "pass" };
  }

  if (!cloud.runtime.ok) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "warn",
      message: "Could not verify subdomain availability",
    };
  }

  if (cloud.slug?.available === false) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "fail",
      message: cloud.slug.message ?? `"${fqdn}" is already taken. Choose a different subdomain.`,
    };
  }

  if (cloud.slug?.message) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "warn",
      message: cloud.slug.message,
    };
  }

  return { id: "slug-available", label: "Subdomain availability", status: "pass" };
}

const CLOUD_EDGE_CNAME = "edge.openship.io";
const DOMAIN_CHECK_TIMEOUT_MS = 4_000;

/**
 * Cloud route flow — the SaaS preflight result is the source of truth.
 * No local DNS check is needed: the cloud has already resolved the
 * customer-facing CNAME and cert state. Mirrors the verified/pending
 * statuses that the Domains tab shows so the deploy modal stays
 * consistent with the dashboard's verification UI.
 */
function checkCustomDomainCloudVerified(
  customDomain: string,
  cloud: NonNullable<CloudPreflightData["customDomain"]>,
): PreflightCheck {
  if (cloud.verified) {
    if (cloud.message) {
      return { id: "domain", label: "Domain DNS", status: "warn", message: cloud.message };
    }
    return { id: "domain", label: "Domain DNS", status: "pass" };
  }

  // Unverified custom domain on a cloud deploy — deploy proceeds via
  // the free `.opsh.io` slug attached alongside the custom one. The
  // custom domain shows as "pending" on the Domains tab with a Verify
  // button; once DNS resolves, the cloud edge attaches a cert.
  return {
    id: "domain",
    label: "Domain DNS",
    status: "warn",
    message:
      cloud.message ??
      `${customDomain} isn't DNS-verified yet — deploy continues on the free .opsh.io domain; verify the custom domain from the Domains tab to attach it.`,
  };
}

/**
 * Self-hosted route flow — operator points the domain at their own
 * server. We compare resolved A records against the server's IPs so
 * the most common DNS mistakes (typo'd IP, leftover parked-domain
 * placeholder) get flagged before the build pipeline wastes ~60s only
 * to fail at certbot. Both lookups are time-bounded so a black-holed
 * resolver can't stall the preflight modal.
 */
async function checkCustomDomainSelfHosted(
  customDomain: string,
  snapshot?: DeploymentConfigSnapshot,
): Promise<PreflightCheck> {
  // Resolve every record type the deploy might care about. Each
  // lookup is capped individually so one slow query can't drag the
  // preflight past its budget.
  const [a, aaaa, cname] = await Promise.all([
    resolveRecords(customDomain, "A", { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS }),
    resolveRecords(customDomain, "AAAA", { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS }),
    resolveRecords(customDomain, "CNAME", { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS }),
  ]);
  const anyResolved = a.length > 0 || aaaa.length > 0 || cname.length > 0;

  if (!anyResolved) {
    return {
      id: "domain",
      label: "Domain DNS",
      status: "warn",
      message: `No DNS records found yet for ${customDomain}. Point it at your server's IP; the deploy continues on the free .opsh.io domain — TLS issuance for ${customDomain} retries after Verify.`,
    };
  }

  // Resolve the server's IP set. If the configured "host" is a
  // hostname (not an IP literal), look it up too — we can't compare
  // an IP record against a hostname string.
  const serverHost = snapshot?.organizationId
    ? await resolveServerHost(snapshot.organizationId, snapshot.serverId).catch(() => null)
    : null;
  let serverIps: string[] = [];
  if (serverHost) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(serverHost) || serverHost.includes(":")) {
      serverIps = [serverHost];
    } else {
      serverIps = await lookupAddresses(serverHost, { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS });
    }
  }

  // Only enforce the IP comparison when we actually have a server IP
  // to compare against. On local-only setups without one, fall
  // through to the permissive "something resolved" check — the
  // operator owns DNS and we can't second-guess.
  if (serverIps.length > 0 && a.length > 0) {
    const matchesServer = a.some((ip) => serverIps.includes(ip));
    if (!matchesServer) {
      return {
        id: "domain",
        label: "Domain DNS",
        status: "warn",
        message: `${customDomain} resolves to ${a.join(", ")} but the server is at ${serverIps.join(", ")}. Point the A record at the server's IP; cert issuance will fail until DNS matches.`,
      };
    }
  }

  return { id: "domain", label: "Domain DNS", status: "pass" };
}

/**
 * Cloud route fallback — caller is targeting cloud but the SaaS-side
 * preflight didn't return customDomain data. Verify the CNAME points
 * at the cloud edge directly. Non-blocking; the .opsh.io free domain
 * stays attached so the deploy still ships.
 */
async function checkCustomDomainCloudCname(
  customDomain: string,
): Promise<PreflightCheck> {
  const records = await resolveRecords(customDomain, "CNAME", {
    timeoutMs: DOMAIN_CHECK_TIMEOUT_MS,
  });
  if (records.length === 0) {
    return {
      id: "domain",
      label: "Domain DNS",
      status: "warn",
      message: `No CNAME record found for ${customDomain} yet. Add a CNAME pointing to ${CLOUD_EDGE_CNAME}, then click Verify on the Domains tab. Deploy continues on the free .opsh.io domain.`,
    };
  }
  if (records.some((record) => record.toLowerCase() === CLOUD_EDGE_CNAME)) {
    return { id: "domain", label: "Domain DNS", status: "pass" };
  }
  return {
    id: "domain",
    label: "Domain DNS",
    status: "warn",
    message: `CNAME for ${customDomain} doesn't point to ${CLOUD_EDGE_CNAME} yet (current: ${records.join(", ")}). Deploy continues on the free .opsh.io domain; fix DNS and verify from the Domains tab to attach the custom domain.`,
  };
}

/**
 * Domain DNS check dispatcher. Picks the right branch based on the
 * effective deploy target — keeps the body of each branch focused.
 */
async function checkCustomDomain(
  customDomain: string,
  cloud: CloudPreflightData | null,
  snapshot?: DeploymentConfigSnapshot,
): Promise<PreflightCheck> {
  if (cloud?.runtime.ok && cloud.customDomain) {
    return checkCustomDomainCloudVerified(customDomain, cloud.customDomain);
  }
  // Route the cloud-vs-self-hosted branch through the SAME authority the rest of
  // preflight + the build pipeline use, so the DNS check can't disagree with where
  // the deploy actually lands. (A hand-rolled ternary here drifted on a cloud-base
  // host carrying a server/local snapshot — it would A-record-check a cloud deploy.)
  const plat = platform();
  const effectiveTarget = resolveEffectiveTarget(plat.target, snapshot ?? {});
  if (effectiveTarget !== "cloud") {
    return checkCustomDomainSelfHosted(customDomain, snapshot);
  }
  return checkCustomDomainCloudCname(customDomain);
}

async function checkCloudRuntime(
  cloud: CloudPreflightData | null,
  requirement: "none" | "cloud-runtime" | "managed-project-domain" | "managed-compose-domains",
  connected: boolean,
): Promise<PreflightCheck> {
  if (requirement === "none") {
    return { id: "runtime", label: "Runtime", status: "pass" };
  }

  if (!cloud) {
    // `cloud === null` means the SaaS preflight call produced no data —
    // and that is TWO different situations we must NOT conflate:
    //   • org IS connected (owner's session validates) but the SaaS call
    //     failed transiently (5xx / network)  → "unreachable, retry"
    //   • org is genuinely NOT connected                 → "connect first"
    // `connected` is the org-owner's validated verdict (same source the
    // dashboard card + GitHub mode read), so a momentary blip never tells a
    // connected user to reconnect.
    if (connected) {
      return {
        id: "runtime",
        label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_UNREACHABLE,
        message:
          "Openship Cloud is connected, but the cloud API didn't respond just now. This is usually transient — retry the deploy in a moment.",
      };
    }

    if (requirement === "managed-project-domain") {
      return {
        id: "runtime",
        label: "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN,
        message: `Free .${getRoutingBaseDomain()} domains require Openship Cloud for routing. To deploy to your own server, either connect Openship Cloud or switch this project to a custom domain.`,
      };
    }

    if (requirement === "managed-compose-domains") {
      return {
        id: "runtime",
        label: "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS,
        message: `One or more exposed services use free .${getRoutingBaseDomain()} domains. Connect Openship Cloud or switch those services to custom domains before deploying to your own server.`,
      };
    }

    return {
      id: "runtime",
      label: "Openship Cloud",
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_TARGET,
      message:
        "This deployment target runs on Openship Cloud, but no cloud account is connected. Connect your account first.",
    };
  }

  if (cloud.runtime.ok) {
    return {
      id: "runtime",
      label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
      status: "pass",
    };
  }

  return {
    id: "runtime",
    label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
    status: "fail",
    message: cloud.runtime.message,
  };
}

export async function runPreflightChecks(
  snapshot: DeploymentConfigSnapshot,
  opts?: PreflightOptions,
): Promise<PreflightResult> {
  const cloudPreflight = await resolveCloudPreflight(snapshot, opts);

  // Determine whether this deployment requires cloud directly or via managed routing
  const plat = platform();
  const effectiveTarget = resolveEffectiveTarget(plat.target, snapshot);
  // Managed routing = the deploy lands on the operator's own host (server/local)
  // but the public hostname is served by cloud edge. Single authority shared
  // with the pipeline (deployment-runtime.ts).
  const usesManagedRouting = usesManagedRoutingFor(plat.target, effectiveTarget);
  const hasEndpointRouting = !!opts?.publicEndpoints?.length;
  const hasManagedProjectDomain =
    !opts?.multiService &&
    !hasEndpointRouting && !!opts?.slug && !opts?.customDomain && usesManagedRouting;
  const hasManagedPublicEndpoints =
    opts?.publicEndpoints?.some((endpoint) => endpoint.domainType !== "custom") ?? false;
  const hasManagedComposeDomains =
    opts?.composeServices?.some((service) => service.exposed && service.domainType !== "custom") ??
    false;
  const cloudRequirement =
    effectiveTarget === "cloud"
      ? "cloud-runtime"
      : hasManagedProjectDomain || hasManagedPublicEndpoints
        ? "managed-project-domain"
        : hasManagedComposeDomains
          ? "managed-compose-domains"
          : "none";

  // The github-auth checks (checkGitHubAppInstallation,
  // checkRemoteBuildTokenLeak, checkRemoteCloneToken) run against the
  // caller's ctx — the single carrier of identity. No leaf synthesis.
  const githubCtx: RequestContext | null = opts?.ctx ?? null;

  const checks: PreflightCheck[] = [
    checkConfig(snapshot, opts),
    opts?.multiService
      ? { id: "stack", label: "Service stack", status: "pass" }
      : checkStack(snapshot),
  ];

  if (!hasEndpointRouting && opts?.slug && !opts?.customDomain) {
    checks.push(checkSlugFormat(opts.slug));
    const fqdn = `${opts.slug}.${getRoutingBaseDomain()}`.toLowerCase();
    const ownedLive = await projectLiveHostnames(opts.projectId);
    if (ownedLive.has(fqdn)) {
      // Redeploy reclaiming its own subdomain — not a conflict.
      checks.push({ id: "slug-available", label: "Subdomain availability", status: "pass" });
    } else {
      checks.push(await checkSlug(opts.slug, cloudPreflight));
    }
  }

  // Only the null-preflight + cloud-required case needs to know whether the
  // org is actually connected (to pick "unreachable, retry" vs "connect
  // first"). Resolve the org-owner's validated verdict just for that case —
  // skip the SaaS round-trip when preflight already returned data or no
  // cloud requirement applies.
  const cloudConnected =
    !cloudPreflight && cloudRequirement !== "none" && snapshot.organizationId
      ? await isCloudConnectedForOrg(snapshot.organizationId).catch(() => false)
      : false;
  checks.push(await checkCloudRuntime(cloudPreflight, cloudRequirement, cloudConnected));

  const effectiveBuildStrategy =
    opts?.buildStrategy ?? (snapshot.buildStrategy as "local" | "server" | undefined);

  // A PUBLIC github.com repo clones with NO credential, so none of the
  // credential checks below should block it — this is how a public repo
  // deploys on Vercel. Probe tokenlessly (cached, fails CLOSED): private /
  // unknown / non-github ⇒ repoIsPublic=false ⇒ existing behavior, nothing
  // regresses. When public, we skip the App-install AND remote-clone-token
  // demands, and the deploy-time clone goes anonymous (clone-auth.ts).
  const ghRepo = parseGithubOwnerRepo(snapshot.repoUrl, opts?.gitOwner, opts?.gitRepo);
  const repoIsPublic = ghRepo ? await isPublicRepo(ghRepo.owner, ghRepo.repo) : false;

  // GitHub App installation check — only relevant when the repo is cloned on a
  // REMOTE build worker (server build). A LOCAL build ("Build on this machine")
  // clones on the API host using local credentials (gh CLI / OAuth), so the
  // cloud App installation is irrelevant — skip it. This mirrors the
  // remote-clone-token check below, which already passes for local builds.
  if (!repoIsPublic && getGitHubAuthMode() === "app" && effectiveBuildStrategy !== "local") {
    checks.push(
      await checkGitHubAppInstallation(githubCtx, opts?.gitOwner),
    );
  }

  // A remote clone credential is only needed when the repo is actually cloned
  // ON the remote build worker. Per the build pipeline (build-pipeline.ts:774),
  // that is ONLY the bare runtime on a server build: Docker builds — including
  // EVERY services deploy — clone on the orchestrator (the token never leaves
  // the API host), and cloud builds clone inside the workspace. So the two
  // credential checks below apply only to bare + server; otherwise the clone is
  // local and these checks would wrongly demand a remote/App/cloud credential.
  const runtimeMode = snapshot.runtimeMode ?? "docker";
  const clonesOnRemote =
    !repoIsPublic &&
    runtimeMode === "bare" &&
    effectiveTarget === "server" &&
    effectiveBuildStrategy !== "local";

  if (clonesOnRemote) {
    // Remote-build credential check. For App-scoped modes (app / cloud-app):
    // pass. For cli mode: hard FAIL (matches clone-auth's refusal to ship a gh
    // CLI token to a remote worker). For oauth/token: warn only.
    checks.push(
      await checkRemoteBuildTokenLeak(githubCtx, effectiveTarget, effectiveBuildStrategy, snapshot.serverId),
    );

    // Atomic remote-clone-token check — mirrors clone-auth.ts at deploy time so
    // any failure here means the remote clone would have failed downstream.
    checks.push(
      await checkRemoteCloneToken(
        githubCtx,
        opts?.gitOwner,
        opts?.projectId,
        effectiveTarget,
        effectiveBuildStrategy,
        snapshot.serverId,
      ),
    );
  }

  // Clone-on-server for DOCKER (opt-in via cloneStrategy). Non-bare runtimes
  // clone locally by default, but "Clone on the server" ships the clone to the
  // build host. Warn (never fail) when no shippable credential exists — the
  // pipeline falls back to an API-host clone + transfer. Skip for bare, which
  // is already covered by the hard-fail clonesOnRemote checks above.
  // Same clone decision the build pipeline uses (resolveClonePlan) — so this
  // credential check verifies exactly the clone the pipeline will perform.
  const dockerClonesOnServer = resolveClonePlan({
    effectiveTarget,
    serverId: snapshot.serverId,
    runtimeIsBare: runtimeMode === "bare",
    cloneStrategy: snapshot.cloneStrategy,
    buildStrategy: effectiveBuildStrategy,
    isDesktop: plat.target === "desktop",
    forwardGitCredentials: snapshot.forwardGitCredentials,
    // GitHub projects carry a parsed gitOwner; docker acquires the source
    // tarball on the server for them. Same structured signal the pipeline uses
    // (`!!project.gitOwner`) so the two decisions can't drift.
    repoIsGithub: !!opts?.gitOwner,
  }).dockerClonesOnServer;
  if (dockerClonesOnServer) {
    checks.push(
      await checkCloneOnServerCredential(
        githubCtx,
        opts?.gitOwner,
        opts?.projectId,
        plat.target,
        snapshot.serverId,
      ),
    );
  }

  if (!hasEndpointRouting && opts?.customDomain) {
    checks.push(await checkCustomDomain(opts.customDomain, cloudPreflight, snapshot));
  }

  if (opts?.composeServices?.length) {
    checks.push(
      ...(await checkComposeServiceDomains(opts.composeServices, opts.slug, cloudPreflight, snapshot)),
    );
  }

  if (opts?.publicEndpoints?.length) {
    checks.push(...(await checkPublicEndpoints(snapshot, opts.publicEndpoints, cloudPreflight, opts.ctx, opts.projectId)));
  }

  // Catch the "this deploy will have no public URL" foot-gun: self-hosted,
  // no cloud requirement (so no managed slug routing), no custom domain,
  // no public endpoints, no compose services exposed. buildProjectRouteDomains
  // returns [] for this shape, registerResolvedRoutes logs
  // "No domains configured" and exits, the container runs but the dashboard's
  // "Open" button is empty. Surface this BEFORE the build kicks off so the
  // operator can attach a domain or connect cloud first.
  const hasAnyCustomDomain = !!opts?.customDomain;
  const hasAnyEndpointDomain = (opts?.publicEndpoints ?? []).some(
    (endpoint) => !!endpoint.domain || !!endpoint.customDomain,
  );
  const hasAnyComposeExposed = (opts?.composeServices ?? []).some(
    (service) => service.exposed,
  );
  const willHavePublicUrl =
    effectiveTarget === "cloud" ||
    cloudRequirement !== "none" ||
    hasAnyCustomDomain ||
    hasAnyEndpointDomain ||
    hasAnyComposeExposed;
  if (!willHavePublicUrl) {
    checks.push({
      id: "public-url",
      label: "Public URL",
      status: "warn",
      message:
        "This deploy has no public domain attached. It will build and start but nothing will route to it. Add a custom domain on the Domains tab or connect Openship Cloud to get a free .opsh.io subdomain.",
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}
