import { repos, type Domain } from "@repo/db";
import { ConflictError } from "@repo/core";
import { CloudRuntime } from "@repo/adapters";
import {
  normalizeStoredPublicEndpoints,
  publicEndpointHostname,
  type StoredPublicEndpoint,
} from "./public-endpoints";
import { assertRedirectTargets, normalizeRedirect } from "./domain-redirect";
import { platform } from "./controller-helpers";
import { getRoutingBaseDomain } from "./routing-domains";
import { generateToken } from "./domain-token";

interface SyncProjectPublicRoutesInput {
  projectId: string;
  endpoints?: StoredPublicEndpoint[] | null;
  currentDomains?: Domain[] | null;
  /**
   * When true, a VERIFIED custom domain is never destroyed by this sync: a row
   * the desired set omits is kept (not deleted), and a desired route that carries
   * no port/path never nulls the row's live target. Only the DEPLOY pipeline sets
   * this — a deploy that resolved to the wrong target (e.g. "local") must not
   * erase a user's proven custom domain (the Access-URL-regressed-to-localhost
   * bug). The Domains editor leaves it false so explicit removals/edits still win.
   */
  preserveVerifiedCustom?: boolean;
}

interface DesiredProjectRoute {
  hostname: string;
  targetPort?: number;
  targetPath?: string;
  domainType: "free" | "custom";
  isPrimary: boolean;
  redirectTo: string | null;
  redirectStatus: number | null;
}

/**
 * If `hostname` is a managed `<slug>.<baseDomain>` (e.g. business-servio.opsh.io),
 * return the slug. Otherwise null - custom domains aren't Oblien-issued.
 */
function managedSlug(hostname: string): string | null {
  const base = getRoutingBaseDomain().toLowerCase();
  const suffix = `.${base}`;
  const normalized = hostname.trim().toLowerCase();
  if (!normalized.endsWith(suffix)) return null;
  const slug = normalized.slice(0, -suffix.length);
  return slug.length > 0 ? slug : null;
}

/**
 * Ask Oblien whether a managed slug is free. Source of truth for `*.opsh.io`
 * subdomains. Returns true/false on a definitive answer, null if we can't
 * reach Oblien - callers treat null as "fall back to local DB".
 */
async function checkManagedSlugAvailable(hostname: string): Promise<boolean | null> {
  const slug = managedSlug(hostname);
  if (!slug) return null;

  const runtime = platform().runtime;
  if (!(runtime instanceof CloudRuntime)) return null;

  try {
    const result = await runtime.checkSlug(slug, getRoutingBaseDomain());
    return result.available;
  } catch {
    return null;
  }
}

/**
 * `findByHostname` finds rows regardless of project state. If the conflicting
 * row belongs to a soft-deleted project, treat it as an orphan: hard-delete it
 * and report no conflict, so the redeploy can proceed.
 */
async function resolveLocalConflict(domainRow: Domain, projectId: string): Promise<Domain | null> {
  if (domainRow.projectId === projectId) return domainRow;

  const owner = await repos.project.findById(domainRow.projectId);
  if (!owner) {
    // Project gone entirely - orphan row, drop it.
    await repos.domain.remove(domainRow.id);
    return null;
  }
  return domainRow;
}

function desiredProjectRoutes(endpoints?: StoredPublicEndpoint[] | null): DesiredProjectRoute[] {
  const seen = new Set<string>();

  return normalizeStoredPublicEndpoints(endpoints).flatMap((endpoint, index) => {
    const hostname = publicEndpointHostname(endpoint);
    if (!hostname || seen.has(hostname)) return [];

    seen.add(hostname);
    const redirect = normalizeRedirect(endpoint);
    return [{
      hostname,
      targetPort: endpoint.port,
      targetPath: endpoint.targetPath,
      domainType: endpoint.domainType,
      isPrimary: index === 0,
      redirectTo: redirect.redirectTo,
      redirectStatus: redirect.redirectStatus,
    } satisfies DesiredProjectRoute];
  });
}

export async function syncProjectPublicRoutes(
  input: SyncProjectPublicRoutesInput,
): Promise<StoredPublicEndpoint[]> {
  const endpoints = normalizeStoredPublicEndpoints(input.endpoints);
  const allExistingDomains = input.currentDomains ?? await repos.domain.listByProject(input.projectId);
  const existingDomains = allExistingDomains
    .filter((domain) => !domain.serviceId);
  const desiredRoutes = desiredProjectRoutes(endpoints);
  // Validate redirects against the FULL desired set before writing anything: a
  // target outside it, or a loop inside it, has to be refused here — once the rows
  // are written the edge would serve the loop.
  assertRedirectTargets(desiredRoutes);
  const desiredByHostname = new Map(desiredRoutes.map((route) => [route.hostname, route]));
  const existingByHostname = new Map(
    allExistingDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );

  for (const domain of existingDomains) {
    if (!desiredByHostname.has(domain.hostname.toLowerCase())) {
      // Keep a verified custom domain the deploy didn't mention — see
      // preserveVerifiedCustom. A row absent from the desired set is otherwise an
      // explicit removal, which the editor path (flag off) still performs.
      if (input.preserveVerifiedCustom && domain.domainType === "custom" && domain.verified) {
        continue;
      }
      await repos.domain.remove(domain.id);
      existingByHostname.delete(domain.hostname.toLowerCase());
    }
  }

  for (const route of desiredRoutes) {
    let existing = existingByHostname.get(route.hostname);

    // A route IS a domain. Free (`*.opsh.io`) routes are host-managed → live
    // immediately. CUSTOM routes must prove DNS ownership first, so a NEW
    // custom row is created pending (with a deterministic verification token)
    // and only the /verify endpoint promotes it. This is the single place that
    // decides verification for endpoint-created rows — the old behavior
    // silently marked custom domains verified with no DNS check.
    const verificationFields =
      route.domainType === "custom"
        ? {
            status: "pending" as const,
            verified: false,
            verificationToken: generateToken(route.hostname),
          }
        : { status: "active" as const, verified: true, verifiedAt: new Date() };

    if (!existing) {
      const globalExisting = await repos.domain.findByHostname(route.hostname);
      if (globalExisting) {
        const resolved = await resolveLocalConflict(globalExisting, input.projectId);
        if (resolved && resolved.projectId !== input.projectId) {
          throw new ConflictError(`Domain "${route.hostname}" is already in use`);
        }
        if (resolved) {
          existing = resolved;
          existingByHostname.set(route.hostname, resolved);
        }
      }
    }

    // For Oblien-managed slugs (e.g. *.opsh.io), Oblien is the source of truth.
    // If local DB looks free but Oblien says taken, surface the real conflict.
    if (!existing) {
      const oblienAvailable = await checkManagedSlugAvailable(route.hostname);
      if (oblienAvailable === false) {
        throw new ConflictError(`Domain "${route.hostname}" is already in use`);
      }
    }

    if (!existing) {
      let created: Domain;
      try {
        created = await repos.domain.create({
          projectId: input.projectId,
          serviceId: null,
          hostname: route.hostname,
          targetPort: route.targetPort,
          targetPath: route.targetPath,
          domainType: route.domainType,
          isPrimary: route.isPrimary,
          redirectTo: route.redirectTo,
          redirectStatus: route.redirectStatus,
          ...verificationFields,
        });
      } catch (err: any) {
        if (err?.cause?.code === "23505" || err?.code === "23505") {
          const conflicting = await repos.domain.findByHostname(route.hostname);
          if (conflicting) {
            const resolved = await resolveLocalConflict(conflicting, input.projectId);
            if (resolved && resolved.projectId !== input.projectId) {
              throw new ConflictError(`Domain "${route.hostname}" is already in use`);
            }
            if (resolved) {
              created = resolved;
            } else {
              // Orphan removed - retry the insert once.
              created = await repos.domain.create({
                projectId: input.projectId,
                serviceId: null,
                hostname: route.hostname,
                targetPort: route.targetPort,
                targetPath: route.targetPath,
                domainType: route.domainType,
                isPrimary: route.isPrimary,
                ...verificationFields,
              });
            }
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      existingByHostname.set(route.hostname, created);
      continue;
    }

    const patch: Record<string, unknown> = {};
    // Never let a deploy that resolved WITHOUT this domain's target (port/path
    // undefined) erase a verified custom domain's live upstream — that nulling is
    // exactly what regressed the Access URL to localhost. An explicit new value is
    // still applied; only a "no target" desired route is treated as "leave as-is".
    const protectTarget =
      input.preserveVerifiedCustom && existing.verified && (existing.domainType ?? route.domainType) === "custom";
    if ((existing.serviceId ?? null) !== null) patch.serviceId = null;
    if (
      (existing.targetPort ?? null) !== (route.targetPort ?? null) &&
      !(protectTarget && route.targetPort === undefined)
    ) {
      patch.targetPort = route.targetPort ?? null;
    }
    if (
      (existing.targetPath ?? null) !== (route.targetPath ?? null) &&
      !(protectTarget && route.targetPath === undefined)
    ) {
      patch.targetPath = route.targetPath ?? null;
    }
    if ((existing.domainType ?? null) !== route.domainType) patch.domainType = route.domainType;
    if (existing.isPrimary !== route.isPrimary) patch.isPrimary = route.isPrimary;
    // The submitted endpoint list is authoritative for the redirect, so an OMITTED
    // one clears it — that's how "stop redirecting, serve the app here" is
    // expressed, and the endpoints round-trip through routeDomainRowToPublicEndpoint
    // so a plain re-save always carries the current value back.
    if ((existing.redirectTo ?? null) !== route.redirectTo) patch.redirectTo = route.redirectTo;
    if ((existing.redirectStatus ?? null) !== route.redirectStatus) {
      patch.redirectStatus = route.redirectStatus;
    }
    // Auto-verify only host-managed (free) rows. A custom row's verified/status
    // is owned by the /verify DNS check — a re-save (port edit, reorder) must
    // NOT silently verify a pending custom nor reset a verified one.
    if (route.domainType !== "custom") {
      if (!existing.verified) {
        patch.verified = true;
        patch.verifiedAt = new Date();
      }
      if (existing.status !== "active") patch.status = "active";
    }

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      existingByHostname.set(route.hostname, { ...existing, ...patch } as Domain);
    }
  }

  return endpoints;
}