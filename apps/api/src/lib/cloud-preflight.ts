import { createPlatform, type CloudRuntime } from "@repo/adapters";
import { getOblienClient, getNamespaceClient, issueNamespaceToken } from "./openship-cloud";
import { getRoutingBaseDomain } from "./routing-domains";
import { safeErrorMessage } from "@repo/core";

/** Normalize a slug the SAME way `syncCloudEdgeProxy` does, so an ownership
 *  look-up matches the value Oblien actually stored. */
function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Does the caller's OWN Oblien namespace already own `<slug>`? `edgeProxy.list`
 * is namespace-scoped (see cloud-edge-proxy.service.ts), so a hit means a
 * redeploy / re-add of a slug this org already holds — available to YOU, not a
 * cross-namespace conflict. Fail-closed (false) when it can't be confirmed.
 */
async function ownsManagedSlug(organizationId: string, rawSlug: string): Promise<boolean> {
  try {
    const slug = normalizeSlug(rawSlug);
    if (!slug) return false;
    const { client } = await getNamespaceClient(organizationId);
    const { proxies } = await client.edgeProxy.list();
    return proxies.some((p) => p.slug === slug);
  } catch {
    return false;
  }
}

/** DNS verification state + required records for a custom domain. */
export interface CustomDomainCheck {
  verified: boolean;
  /** Routing (CNAME or A) record points at Oblien's edge. */
  cname?: boolean;
  /** Ownership TXT challenge observed. */
  ownership?: boolean;
  message?: string;
  /** Records the user must add. Dashboard renders copy-paste cards. */
  requiredRecords?: {
    cname?: { host: string; target: string };
    txt?: { host: string; value: string };
  };
}

export interface CloudPreflightData {
  runtime: { ok: boolean; message?: string };
  slug?: { available: boolean; message?: string };
  customDomain?: CustomDomainCheck;
}

/**
 * Cloud deployment preflight.
 *
 * Runs only inside the SaaS API (mounted via `cloudSaasRoutes`), so we
 * always have master credentials on hand. Each check uses the right
 * scope:
 *
 *   - `runtime` + `getQuota`  → namespace-scoped client (quota lives
 *                               inside the user's namespace).
 *   - `slug` check            → MASTER client. Availability on the
 *                               shared `.opsh.io` zone is an
 *                               account-level read; namespace tokens
 *                               may be rejected (same scope rule that
 *                               required the `pages.create` SaaS
 *                               proxy). Hitting Oblien directly with
 *                               the master client makes this check
 *                               actually authoritative.
 *   - `customDomain`          → namespace-scoped client (DNS records
 *                               are tied to the user's namespace).
 *
 * Errors are NO LONGER silently treated as "available". If the check
 * truly fails (network blip, Oblien outage), we surface
 * `available: false` with a "couldn't verify" message — fail-closed
 * so the user picks a different slug or retries instead of investing
 * minutes in a build that ends with "slug already taken."
 */
export async function runCloudPreflight(
  organizationId: string,
  opts: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData> {
  const baseDomain = getRoutingBaseDomain();

  // ── Namespace-scoped checks: quota + custom domain DNS ──
  let cloud: CloudRuntime | null = null;
  let runtimeError: string | null = null;
  try {
    const token = await issueNamespaceToken(organizationId);
    const cloudPlatform = await createPlatform({ target: "cloud", cloudToken: token.token });
    cloud = cloudPlatform.runtime as CloudRuntime;
    await cloud.getQuota();
  } catch (err) {
    runtimeError = safeErrorMessage(err);
  }

  const result: CloudPreflightData = {
    runtime: runtimeError
      ? { ok: false, message: `Cannot connect to cloud runtime: ${runtimeError}` }
      : { ok: true },
  };

  // ── Slug availability on the shared zone — MASTER client ──
  if (opts.slug) {
    try {
      const master = getOblienClient();
      const slug = await master.domain.checkSlug({ slug: opts.slug, domain: baseDomain });
      // `checkSlug` is OWNER-BLIND (global zone read, no namespace), so a slug
      // this org ALREADY owns reads as "taken". Before failing, confirm it isn't
      // ours — a redeploy / re-add of your own slug must NOT be blocked.
      result.slug =
        slug.available || (await ownsManagedSlug(organizationId, opts.slug))
          ? { available: true }
          : {
              available: false,
              message: `"${opts.slug}.${baseDomain}" is already taken by another account. Choose a different subdomain.`,
            };
    } catch (err) {
      const message = safeErrorMessage(err);
      console.error("[CLOUD] Preflight slug check failed", { slug: opts.slug, error: message });
      // Fail closed — the user should pick a different slug rather than
      // discover the conflict mid-build.
      result.slug = {
        available: false,
        message: `Couldn't verify "${opts.slug}.${baseDomain}" availability. Try again or pick a different subdomain.`,
      };
    }
  }

  // ── Custom domain DNS — namespace-scoped (skipped if runtime down) ──
  if (opts.customDomain && cloud) {
    try {
      const verified = await cloud.verifyDomain(opts.customDomain);
      if (verified.verified) {
        result.customDomain = {
          verified: true,
          cname: verified.cname ?? undefined,
          ownership: verified.ownership ?? undefined,
        };
      } else {
        // Build an actionable message from Oblien's errors AND surface
        // BOTH cname + txt required-records. Previously only cname was
        // mentioned — users hit "DNS not verifying" with no idea the
        // TXT ownership record was also missing.
        const cnameMissing = verified.cname === false;
        const ownershipMissing = verified.ownership === false;
        const missing: string[] = [];
        if (cnameMissing && verified.requiredRecords.cname) {
          missing.push(`CNAME ${verified.requiredRecords.cname.host} → ${verified.requiredRecords.cname.target}`);
        }
        if (ownershipMissing && verified.requiredRecords.txt) {
          missing.push(`TXT ${verified.requiredRecords.txt.host} = ${verified.requiredRecords.txt.value}`);
        }
        const baseMessage = verified.errors.length > 0
          ? verified.errors.join("; ")
          : `DNS not configured for ${opts.customDomain}.`;
        const message = missing.length > 0
          ? `${baseMessage} Add: ${missing.join("  AND  ")}`
          : baseMessage;
        result.customDomain = {
          verified: false,
          cname: verified.cname ?? undefined,
          ownership: verified.ownership ?? undefined,
          message,
          requiredRecords: verified.requiredRecords,
        };
      }
    } catch (err) {
      const message = safeErrorMessage(err);
      console.error("[CLOUD] Preflight custom domain check failed", { domain: opts.customDomain, error: message });
      result.customDomain = {
        verified: false,
        message: `Couldn't verify ${opts.customDomain}. Try again or fix DNS first.`,
      };
    }
  } else if (opts.customDomain && !cloud) {
    result.customDomain = {
      verified: false,
      message: "Cloud runtime unreachable — couldn't verify DNS.",
    };
  }

  return result;
}