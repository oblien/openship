/**
 * The cloud client facade — the single typed surface the rest of the app uses
 * to talk to api.openship.io. Construction takes the scope (userId or
 * organizationId) once; every method dispatches through the matching transport
 * primitive (cloudFetch vs cloudFetchAsOrgOwner) based on that scope:
 *
 *   cloudClient({ userId })          → cloudFetch(userId, …)
 *   cloudClient({ organizationId })  → cloudFetchAsOrgOwner(orgId, …)
 *
 * Methods that look up cached state (token) key off the resolved cloud user id
 * — for org scope, that's the org owner (resolveOrgCloudUserId).
 */
import type { DatabaseDump } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { CloudPreflightData } from "../cloud-preflight";
import { cacheStore } from "../cache-store";
import {
  cloudFetch,
  cloudFetchAsOrgOwner,
  readCloudJson,
  resolveOrgCloudUserId,
} from "./transport";
import { clearCloudSession } from "./session";
import { cloudRequestError } from "./request-error";
import type {
  CloudAccount,
  CloudClient,
  CloudClientScope,
  CloudEdgeVerificationChallenge,
  CloudEdgeVerificationResult,
  CloudGithubInstallation,
  CloudGithubInstallationToken,
  CloudGithubUserStatus,
  TokenCache,
} from "./types";

// Refresh tokens 5 min before Oblien's 30-min TTL so a cached value is always
// still valid.
const TOKEN_TTL_S = 25 * 60;

export function cloudClient(scope: CloudClientScope): CloudClient {
  const isUserScope = "userId" in scope;

  /** Authenticated SaaS fetch using the bound scope. */
  const fetchScoped = (path: string, init?: RequestInit) =>
    isUserScope
      ? cloudFetch(scope.userId, path, init)
      : cloudFetchAsOrgOwner(scope.organizationId, path, init);

  /** Resolve the underlying cloud-linked user id for cache keys. Returns
   *  null when org scope is used and no member has linked Openship Cloud. */
  const resolveUserId = async (): Promise<string | null> => {
    if (isUserScope) return scope.userId;
    return resolveOrgCloudUserId(scope.organizationId);
  };

  /**
   * Shared POST-and-decode pattern for the cloud client's `{ok}`-shaped
   * methods. Handles every failure mode the caller cares about:
   *   - No SaaS session for this scope        → { ok: false, error: "Not connected..." }
   *   - HTTP error (4xx/5xx)                  → { ok: false, error, code?, projectCount? }
   *   - Non-JSON success body                 → { ok: false, error: "non-JSON response" }
   *   - Success                               → { ok: true, ...body }
   *
   * Error responses pass through `code` and `projectCount` from the
   * SaaS body for the methods that declare them; methods that don't
   * just receive `undefined` and TypeScript is happy.
   */
  async function postCloud<TOk extends object>(opts: {
    path: string;
    body?: unknown;
    errorLabel: string;
  }): Promise<
    | ({ ok: true } & TOk)
    | { ok: false; error: string; code?: string; projectCount?: number }
  > {
    const res = await fetchScoped(opts.path, {
      method: "POST",
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res) {
      return { ok: false, error: "Not connected to Openship Cloud" };
    }
    if (!res.ok) {
      const err = await readCloudJson<{
        error?: string;
        code?: string;
        projectCount?: number;
      }>(res);
      return {
        ok: false,
        error: err?.error ?? `${opts.errorLabel} failed: HTTP ${res.status}`,
        code: err?.code,
        projectCount: err?.projectCount,
      };
    }
    const body = await readCloudJson<TOk>(res);
    if (!body) {
      return { ok: false, error: "Cloud returned a non-JSON response" };
    }
    return { ok: true, ...body };
  }

  return {
    request: (path: string, init?: RequestInit) => fetchScoped(path, init),
    github: {
      async installUrl() {
        const res = await fetchScoped("/api/cloud/github/install-url", {
          method: "POST",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: { url: string; state: string } }>(res);
        return json?.data ?? null;
      },
      async oauthHandoff() {
        const res = await fetchScoped("/api/cloud/github/oauth-handoff", {
          method: "POST",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: { url: string } }>(res);
        return json?.data ?? null;
      },
      async userStatus() {
        const res = await fetchScoped("/api/cloud/github/user-status", {
          method: "GET",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: CloudGithubUserStatus }>(res);
        return json?.data ?? null;
      },
      async installations() {
        const res = await fetchScoped("/api/cloud/github/installations", {
          method: "GET",
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: CloudGithubInstallation[] }>(res);
        return json?.data ?? null;
      },
      async installationToken(owner, repos) {
        const res = await fetchScoped("/api/cloud/github/installation-token", {
          method: "POST",
          body: JSON.stringify({ owner, repos }),
        });
        if (!res || !res.ok) return null;
        const json = await readCloudJson<{ data: CloudGithubInstallationToken }>(res);
        return json?.data ?? null;
      },
    },

    pages: {
      async create(input) {
        const res = await fetchScoped("/api/cloud/pages", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!res) {
          throw new Error(
            "Not connected to Openship Cloud — connect your account in Settings.",
          );
        }
        if (!res.ok) {
          let detail = `Cloud page creation failed: HTTP ${res.status}`;
          const body = await readCloudJson<{ error?: string }>(res);
          if (body?.error) detail = body.error;
          throw new Error(detail);
        }
        const body = await readCloudJson<{ page: { slug: string; url?: string | null } }>(res);
        if (!body) {
          throw new Error(
            "Cloud returned a non-JSON response when creating the page.",
          );
        }
        return body;
      },
      async disable(slug) {
        const res = await fetchScoped("/api/cloud/pages/disable", {
          method: "POST",
          body: JSON.stringify({ slug }),
        });
        if (!res) {
          throw new Error(
            "Not connected to Openship Cloud — connect your account in Settings.",
          );
        }
        if (!res.ok) {
          let detail = `Cloud page disable failed: HTTP ${res.status}`;
          const body = await readCloudJson<{ error?: string }>(res);
          if (body?.error) detail = body.error;
          throw new Error(detail);
        }
      },
      async enable(slug) {
        const res = await fetchScoped("/api/cloud/pages/enable", {
          method: "POST",
          body: JSON.stringify({ slug }),
        });
        if (!res) {
          throw new Error(
            "Not connected to Openship Cloud — connect your account in Settings.",
          );
        }
        if (!res.ok) {
          let detail = `Cloud page enable failed: HTTP ${res.status}`;
          const body = await readCloudJson<{ error?: string }>(res);
          if (body?.error) detail = body.error;
          throw new Error(detail);
        }
      },
      async delete(slug) {
        const res = await fetchScoped("/api/cloud/pages/delete", {
          method: "POST",
          body: JSON.stringify({ slug }),
        });
        if (!res) {
          throw new Error(
            "Not connected to Openship Cloud — connect your account in Settings.",
          );
        }
        if (!res.ok) {
          let detail = `Cloud page delete failed: HTTP ${res.status}`;
          const body = await readCloudJson<{ error?: string }>(res);
          if (body?.error) detail = body.error;
          throw new Error(detail);
        }
      },
    },

    edgeProxy: {
      async sync(input) {
        const res = await fetchScoped("/api/cloud/edge-proxy", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!res) return null;
        // Typed, because the verify-and-retry flow has to tell `target_unverified`
        // (re-provable) from a slug conflict or a private-target refusal (not), and
        // those arrive as the same 4xx shape.
        if (!res.ok) throw await cloudRequestError(res, "Edge proxy sync");
        const body = await readCloudJson<{ ok: true; hostname: string }>(res);
        return body ?? null;
      },
      async deregister(slug) {
        const res = await fetchScoped("/api/cloud/edge-proxy/delete", {
          method: "POST",
          body: JSON.stringify({ slug }),
        });
        if (!res) return null; // not connected — best-effort no-op
        if (!res.ok) throw await cloudRequestError(res, "Edge proxy deregister");
        return readCloudJson<{ ok: true; removed: boolean }>(res) ?? null;
      },
      async requestVerification(target) {
        const res = await fetchScoped("/api/cloud/edge-proxy/verify", {
          method: "POST",
          body: JSON.stringify({ target }),
        });
        if (!res) return null;
        if (!res.ok) throw await cloudRequestError(res, "Edge target verification request");
        const body = await readCloudJson<{ ok: true; verification: CloudEdgeVerificationChallenge }>(res);
        return body?.verification ?? null;
      },
      async checkVerification(verificationId) {
        const res = await fetchScoped("/api/cloud/edge-proxy/verify-check", {
          method: "POST",
          body: JSON.stringify({ verificationId }),
        });
        if (!res) return null;
        if (!res.ok) throw await cloudRequestError(res, "Edge target verification check");
        const body = await readCloudJson<{ ok: true; verification: CloudEdgeVerificationResult }>(res);
        return body?.verification ?? null;
      },
    },

    analytics: {
      async timeseries<T>(domain: string, params?: Record<string, unknown>) {
        const res = await fetchScoped("/api/cloud/analytics", {
          method: "POST",
          body: JSON.stringify({ operation: "timeseries", domain, params }),
        });
        if (!res?.ok) return null;
        return readCloudJson<T>(res);
      },
      async requests<T>(domain: string, params?: Record<string, unknown>) {
        const res = await fetchScoped("/api/cloud/analytics", {
          method: "POST",
          body: JSON.stringify({ operation: "requests", domain, params }),
        });
        if (!res?.ok) return null;
        return readCloudJson<T>(res);
      },
      async streamToken<T>(domain: string, params?: Record<string, unknown>) {
        const res = await fetchScoped("/api/cloud/analytics", {
          method: "POST",
          body: JSON.stringify({ operation: "streamToken", domain, params }),
        });
        if (!res?.ok) return null;
        return readCloudJson<T>(res);
      },
    },

    async preflight(input) {
      const res = await fetchScoped("/api/cloud/preflight", {
        method: "POST",
        body: JSON.stringify(input),
      });
      // Each null path means something different — log which one so a
      // "connected but unreachable" preflight is diagnosable instead of
      // opaque (no owner-link/send vs SaaS error vs response-shape).
      if (!res) {
        console.warn("[cloud preflight] no response (owner-link missing, or fetch failed/timed out)");
        return null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[cloud preflight] SaaS returned ${res.status}: ${body.slice(0, 300)}`);
        return null;
      }
      const json = await readCloudJson<{ data: CloudPreflightData }>(res);
      if (!json?.data) {
        console.warn("[cloud preflight] 200 but no { data } in body (non-JSON or shape mismatch)");
        return null;
      }
      return json.data;
    },

    async account() {
      const res = await fetchScoped("/api/cloud/account", { method: "GET" });
      if (!res || !res.ok) return null;
      const json = await readCloudJson<{ user?: CloudAccount }>(res);
      return json?.user ?? null;
    },

    async disconnect() {
      // Only meaningful at user scope — there is no "org-level" SaaS session
      // to revoke. For org scope we resolve the linked owner and disconnect
      // them; this mirrors the org→owner pattern used elsewhere.
      const userId = await resolveUserId();
      if (!userId) return;
      try {
        const res = await cloudFetch(userId, "/api/cloud/disconnect", {
          method: "POST",
        });
        if (res && !res.ok) {
          console.warn(
            `[cloud disconnect] SaaS returned ${res.status} on session revoke; clearing local anyway`,
          );
        }
      } catch (err) {
        console.warn(
          `[cloud disconnect] SaaS revoke failed (clearing local anyway):`,
          safeErrorMessage(err),
        );
      }
      await clearCloudSession(userId);
    },

    async sendInvitation(input) {
      return postCloud<{ messageId: string }>({
        path: "/api/cloud/send-invitation",
        body: input,
        errorLabel: "Cloud invitation relay",
      });
    },

    async ingestSubgraph(input) {
      return postCloud<{
        organizationId: string;
        publicUrl: string;
        imported: Record<string, number>;
      }>({
        path: "/api/cloud/ingest-subgraph",
        body: input,
        errorLabel: "Cloud subgraph ingest",
      });
    },

    async exportSubgraph(input) {
      return postCloud<{ dump: DatabaseDump }>({
        path: "/api/cloud/export-subgraph",
        body: input,
        errorLabel: "Cloud subgraph export",
      });
    },

    async teardownProject(input) {
      return postCloud<Record<string, never>>({
        path: "/api/cloud/teardown-project",
        body: input,
        errorLabel: "Cloud project teardown",
      });
    },

    async token() {
      const userId = await resolveUserId();
      if (!userId) return null;
      const store = await cacheStore<TokenCache>("oblien-ns-tokens");
      const cached = await store.get(userId);
      if (cached) return cached;

      const res = await cloudFetch(userId, "/api/cloud/token", { method: "POST" });
      if (!res || !res.ok) return null;

      const json = await readCloudJson<{
        data: { token: string; namespace: string; expiresAt: string };
      }>(res);
      if (!json?.data) return null;

      const entry: TokenCache = { token: json.data.token, namespace: json.data.namespace };
      await store.set(userId, entry, TOKEN_TTL_S);
      return entry;
    },
  };
}

// ─── Namespace token fetching ────────────────────────────────────────────────

/**
 * Org-scoped cloud-token lookup. Returns the owner's cloud token — only the
 * owner can link Openship Cloud, and their connection is the org's cloud
 * identity for every member to use under the hood.
 */
export async function getOrgCloudToken(
  organizationId: string,
): Promise<{ token: string; namespace: string; userId: string } | null> {
  const userId = await resolveOrgCloudUserId(organizationId);
  if (!userId) return null;
  const token = await cloudClient({ userId }).token();
  if (!token) return null;
  return { ...token, userId };
}
