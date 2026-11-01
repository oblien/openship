import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { createPlatform, type CloudInfraProvider } from "@repo/adapters";
import { ensureNamespace, getOblienClient, issueNamespaceToken } from "./openship-cloud";
import { env } from "../config/env";
import { assertCloudCanSpend } from "../modules/billing/billing-oblien-quota";
import { getRoutingBaseDomain } from "./routing-domains";
import { safeErrorMessage } from "@repo/core";
import type { CloudWorkspaceScope } from "./cloud-workspace-scope";

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
 * Check all route types, including Pages and workspace public access. The
 * registry requires admin scope, so filter by the trusted namespace twice.
 */
async function ownsManagedSlug(organizationId: string, rawSlug: string, workspaceId?: CloudWorkspaceScope): Promise<boolean> {
  try {
    const slug = normalizeSlug(rawSlug);
    if (!slug) return false;
    const namespace = await ensureNamespace(organizationId, workspaceId);
    const { data } = await getOblienClient().domain.routes({ namespace });
    const hostname = `${slug}.${getRoutingBaseDomain()}`;
    return data.some((route) => route.namespace === namespace && route.hostname.toLowerCase() === hostname);
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud-preflight");
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
 *   - `runtime`              → namespace entitlement, balance, scoped token.
 *                               The reseller's workspace capacity is not a
 *                               customer billing/readiness check.
 *   - `slug` check            → MASTER client. Availability on the
 *                               shared `.opsh.io` zone is an
 *                               account-level read; namespace tokens
 *                               may be rejected (same scope rule that
 *                               required the `pages.create` SaaS
 *                               proxy). Hitting Oblien directly with
 *                               the master client makes this check
 *                               actually authoritative.
 *   - `customDomain`          → MASTER client. Oblien's standalone
 *                               DNS verification endpoint requires admin
 *                               scope, just like slug availability. Tenant
 *                               entitlement still gates the check below.
 *
 * Errors are NO LONGER silently treated as "available". If the check
 * truly fails (network blip, Oblien outage), we surface
 * `available: false` with a "couldn't verify" message — fail-closed
 * so the user picks a different slug or retries instead of investing
 * minutes in a build that ends with "slug already taken."
 */
export async function runCloudPreflight(
  organizationId: string,
  opts: { slug?: string; customDomain?: string; workspaceId?: CloudWorkspaceScope },
): Promise<CloudPreflightData> {
  const baseDomain = getRoutingBaseDomain();

  // ── Namespace-scoped entitlement / runtime checks ──
  let cloud: CloudInfraProvider | null = null;
  let runtimeError: string | null = null;
  try {
    const token = await issueNamespaceToken(organizationId, opts.workspaceId);
    await assertCloudCanSpend(organizationId, opts.workspaceId);
    const cloudPlatform = await createPlatform({
      target: "cloud", cloudToken: token.token, cloudNamespace: token.namespace,
      cloudApiUrl: env.OBLIEN_API_URL,
    });
    cloud = cloudPlatform.routing as CloudInfraProvider;
  } catch (err) {
    observeCaughtError(err, "platform/engine/lib/cloud-preflight");
    runtimeError = safeErrorMessage(err);
  }

  const result: CloudPreflightData = {
    runtime: runtimeError
      ? { ok: false, message: `Cloud deployment check failed: ${runtimeError}` }
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
        slug.available || (await ownsManagedSlug(organizationId, opts.slug, opts.workspaceId))
          ? { available: true }
          : {
              available: false,
              message: `"${opts.slug}.${baseDomain}" is already taken by another account. Choose a different subdomain.`,
            };
    } catch (err) {
      const message = safeErrorMessage(err);
      errorDiagnostics.error("platform/engine/lib/cloud-preflight", "[CLOUD] Preflight slug check failed", { slug: opts.slug, error: message }, err);
      // Fail closed — the user should pick a different slug rather than
      // discover the conflict mid-build.
      result.slug = {
        available: false,
        message: `Couldn't verify "${opts.slug}.${baseDomain}" availability. Try again or pick a different subdomain.`,
      };
    }
  }

  // ── Custom domain DNS — server-side admin scope, after tenant checks ──
  if (opts.customDomain && cloud) {
    try {
      const verified = await getOblienClient().domain.verify({ domain: opts.customDomain });
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
        if (cnameMissing && verified.required_records.cname) {
          missing.push(`CNAME ${verified.required_records.cname.host} → ${verified.required_records.cname.target}`);
        }
        if (ownershipMissing && verified.required_records.txt) {
          missing.push(`TXT ${verified.required_records.txt.host} = ${verified.required_records.txt.value}`);
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
          requiredRecords: verified.required_records,
        };
      }
    } catch (err) {
      const message = safeErrorMessage(err);
      errorDiagnostics.error("platform/engine/lib/cloud-preflight", "[CLOUD] Preflight custom domain check failed", { domain: opts.customDomain, error: message }, err);
      result.customDomain = {
        verified: false,
        message: `Couldn't verify ${opts.customDomain} right now. Please retry.`,
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
