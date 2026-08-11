/**
 * Shared types for the cloud client layer (lib/cloud/*).
 *
 * The SaaS (api.openship.io) is the source of truth. A self-hosted instance
 * stores only the per-user encrypted `cloud_session_token` (user_settings) and
 * talks to the SaaS through the transport → session → client layers here.
 */
import type { DatabaseDump, SubgraphScope } from "@repo/db";
import type { CloudPreflightData } from "../cloud-preflight";

export interface CloudAccount {
  name: string;
  email: string;
  image?: string | null;
}

/** Cached Oblien namespace token (the `oblien-ns-tokens` cacheStore). */
export interface TokenCache {
  token: string;
  namespace: string;
}

// ─── GitHub App proxy types (cloud holds the App private key) ───────────────
//
// Self-hosted instances never hold GITHUB_APP_ID / GITHUB_PRIVATE_KEY.
// All App-scoped operations (install URL, list installations, mint install
// tokens, OAuth identity) are proxied through api.openship.io which is the
// sole holder of the App credentials. The local instance authenticates with
// its cloud_session_token (same as every other cloud-proxied feature).

export interface CloudGithubInstallation {
  id: number;
  login: string;
  avatarUrl: string;
  type: "User" | "Organization";
}

export interface CloudGithubInstallationToken {
  token: string;
  /** ISO 8601 timestamp - GitHub install tokens expire in 60min. */
  expiresAt: string;
}

export interface CloudGithubUserStatus {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  id?: number;
}

// ─── Edge-target verification (Openship Cloud proves control of a target) ────
//
// Mirrors Oblien's `EdgeProxyVerification*` shapes, restated here rather than
// re-exported: the SDK is a SaaS-side dependency, and a self-hosted box must be
// able to type this call without pulling it in.

export type CloudEdgeVerificationStatus = "pending" | "verified" | "failed" | "expired";

/** What to serve, and where, to prove control of a target. */
export interface CloudEdgeVerificationChallenge {
  id: number;
  target: string;
  /** Absolute path the token must answer on, e.g.
   *  `/.well-known/oblien-proxy-challenge/<token>`. Stored verbatim rather than
   *  reconstructed — the upstream owns this path shape, not us. */
  path: string;
  /** Exact body to return with HTTP 200 at `path`. */
  token: string;
  instructions?: string;
}

/** Outcome of a probe. `error` is the upstream's own reason and is the only thing
 *  that names the real cause (DNS, firewall, a proxy in front), so it is surfaced
 *  verbatim rather than replaced with a generic message. */
export interface CloudEdgeVerificationResult {
  id: number;
  target: string;
  status: CloudEdgeVerificationStatus;
  validatedIp?: string | null;
  expiresAt?: string | null;
  error?: string;
}

/**
 * The identity a cloud call runs as:
 *   - { userId }         → act AS this user (the connect/identity flow, and the
 *                          primitive every org-scoped call resolves down to).
 *   - { organizationId } → act as the org's cloud OWNER (all org operations);
 *                          resolves owner → userId under the hood.
 */
export type CloudClientScope = { userId: string } | { organizationId: string };

export interface CloudClient {
  github: {
    installUrl(): Promise<{ url: string; state: string } | null>;
    oauthHandoff(): Promise<{ url: string } | null>;
    userStatus(): Promise<CloudGithubUserStatus | null>;
    installations(): Promise<CloudGithubInstallation[] | null>;
    installationToken(
      owner: string,
      repos?: string[],
    ): Promise<{ token: string; expiresAt: string } | null>;
  };
  pages: {
    create(input: {
      workspace_id: string;
      path: string;
      name: string;
      slug: string;
      domain?: string;
    }): Promise<{ page: { slug: string; url?: string | null } }>;
    disable(slug: string): Promise<void>;
    enable(slug: string): Promise<void>;
    delete(slug: string): Promise<void>;
  };
  edgeProxy: {
    sync(input: {
      slug: string;
      target: string;
    }): Promise<{ ok: true; hostname: string } | null>;
    deregister(slug: string): Promise<{ ok: true; removed: boolean } | null>;
    /**
     * Ask Openship Cloud for a challenge proving we control `target`.
     *
     * `target` MUST be `canonicalEdgeTarget(host)` — the row is keyed on the
     * normalized string, so a target verified in one spelling and routed in
     * another stays permanently unverified.
     *
     * Re-requesting RESETS the token, which is why the caller keeps serving the
     * previous one (see the retired-token rule on the persistence side).
     */
    requestVerification(target: string): Promise<CloudEdgeVerificationChallenge | null>;
    /** Run the probe. Openship Cloud fetches the token from the target itself; we
     *  only report the outcome. One call per attempt — never a poll loop. */
    checkVerification(verificationId: number): Promise<CloudEdgeVerificationResult | null>;
  };
  analytics: {
    timeseries<T>(domain: string, params?: Record<string, unknown>): Promise<T | null>;
    requests<T>(domain: string, params?: Record<string, unknown>): Promise<T | null>;
    streamToken<T>(domain: string, params?: Record<string, unknown>): Promise<T | null>;
  };
  preflight(input: {
    slug?: string;
    customDomain?: string;
  }): Promise<CloudPreflightData | null>;
  account(): Promise<CloudAccount | null>;
  disconnect(): Promise<void>;
  token(): Promise<{ token: string; namespace: string } | null>;
  /**
   * Raw scoped fetch. Returns `null` when the scope has no stored
   * cloud session (no token → no bearer). Otherwise the SaaS Response
   * is forwarded verbatim — caller owns status/body handling.
   *
   * For passthrough proxies (billing-local, future modules) that need
   * to forward arbitrary SaaS paths without a typed wrapper. Prefer
   * a named method when you're calling a fixed endpoint.
   */
  request(path: string, init?: RequestInit): Promise<Response | null>;
  /**
   * Relay an organization invitation email through the SaaS's mail
   * infrastructure. Used by self-hosted instances that have opted into
   * `invitationMailSource = "cloud"`. Org-scoped — the org owner's cloud
   * session token authenticates the call on the SaaS side.
   */
  sendInvitation(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;
  /**
   * Forward primitive — upload a SubgraphScope dump to the SaaS.
   *
   * Used by team-mode migration Path B (org-scope) and project
   * transfer (project-scope). The SaaS derives the target org from
   * the caller's session and remaps every organizationId column onto
   * it. Returns the public URL teammates use to sign in.
   *
   * Org-scoped on the caller side: the operator's cloud session
   * authenticates as the org owner. `allowNonEmptyTarget=true`
   * acknowledges that the target org may already have rows and
   * proceeds anyway — the operator handles any PK collisions. It
   * does NOT wipe existing rows before insert.
   */
  ingestSubgraph(input: {
    dump: DatabaseDump;
    allowNonEmptyTarget?: boolean;
  }): Promise<
    | { ok: true; organizationId: string; publicUrl: string; imported: Record<string, number> }
    | { ok: false; error: string; code?: string; projectCount?: number }
  >;
  /**
   * Generalised reverse primitive — fetch a SubgraphScope dump from the
   * SaaS. Used by team-mode switch-back (org-scope) and project transfer
   * back (project-scope).
   */
  exportSubgraph(input: {
    scope: SubgraphScope;
  }): Promise<
    | { ok: true; dump: DatabaseDump }
    | { ok: false; error: string; code?: string }
  >;
  /**
   * Delete a project's rows on the SaaS for the caller's org. Used by the
   * bring-home flow (drop the cloud copy after demote) and by promote
   * reconcile (clean a leftover cloud copy before re-ingesting). Ownership is
   * enforced SaaS-side — the project must belong to the caller's org.
   */
  teardownProject(input: {
    projectId: string;
  }): Promise<
    | { ok: true }
    | { ok: false; error: string; code?: string }
  >;
}
