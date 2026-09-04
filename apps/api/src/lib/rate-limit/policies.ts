/**
 * Named rate-limit policies — the public surface of the rate-limit
 * module from a route's perspective.
 *
 * Add a route's rate-limit by name in `secureRouter`:
 *
 *   secureRouter.post("/auth/sign-in", { public: true, rateLimit: "auth-tight" }, ...)
 *   secureRouter.get("/projects",      { tag: "project:list", rateLimit: "read-authed" }, ...)
 *
 * Adding a policy:
 *   1. Add the entry below.
 *   2. Add the policy id to PolicyId.
 *   3. Document the use case in the description.
 *
 * Limits are deliberately conservative — easier to raise on operator
 * feedback than to retroactively tighten after an incident.
 */

import type { RateLimitPolicy } from "./types";

const MINUTE_MS = 60_000;

/** All policy ids — keep in sync with `POLICIES` below. */
export type PolicyId =
  | "default-anon"
  | "default-authed"
  | "auth-tight"
  | "auth-loose"
  | "transfer-chunk"
  | "mcp"
  | "read-authed"
  | "write-authed"
  | "webhook-ingress"
  | "billing-portal";

export const POLICIES: Record<PolicyId, RateLimitPolicy> = {
  /** Conservative default for unauthed routes. Per-IP. */
  "default-anon": {
    id: "default-anon",
    limit: 300,
    windowMs: MINUTE_MS,
    subject: "ip",
    description: "Default for public/unauthed routes (per-IP).",
  },

  /** Default for authed routes. Per-user — far more accurate than IP.
   *  ~50/s: a dashboard render fans out many concurrent reads (github/home,
   *  session, health/env, org lists) so the per-user ceiling is generous. */
  "default-authed": {
    id: "default-authed",
    limit: 3000,
    windowMs: MINUTE_MS,
    subject: "user",
    description: "Default for authed routes (per-user).",
  },

  /** Login / signup / password-reset. Tight per-IP gate against
   *  credential stuffing + brute-force. */
  "auth-tight": {
    id: "auth-tight",
    limit: 10,
    windowMs: MINUTE_MS,
    subject: "ip",
    description: "Login/signup/reset endpoints — per-IP, brute-force gate.",
  },

  /** Authed auth operations (logout, switch org, session refresh).
   *  Looser than the login gate because session is already proven. */
  "auth-loose": {
    id: "auth-loose",
    limit: 60,
    windowMs: MINUTE_MS,
    subject: "user",
    description: "Authed session ops (logout, refresh) — per-user.",
  },

  /** Public direct-transfer chunks are cryptographically capability-gated but
   *  arrive in bursts. Bound abuse per IP without throttling a valid 500 MB move. */
  "transfer-chunk": {
    id: "transfer-chunk",
    limit: 240,
    windowMs: MINUTE_MS,
    subject: "ip",
    description: "Encrypted direct-transfer chunks — per-IP burst allowance.",
  },

  /** MCP JSON-RPC endpoint (/api/mcp). Per-IP because the endpoint
   *  authenticates the PAT/OAuth credential itself (an unauthed probe still
   *  does a DB lookup, so keep it bounded), but far higher than `auth-tight`:
   *  a single connected client fires many requests per session (initialize +
   *  tools/list + one per tools/call), which `auth-tight`'s 10/min throttled. */
  "mcp": {
    id: "mcp",
    limit: 300,
    windowMs: MINUTE_MS,
    subject: "ip",
    description: "MCP JSON-RPC endpoint — per-IP; generous for tool-call bursts.",
  },

  /** Read API — list, get, query. Per-user, generous. */
  "read-authed": {
    id: "read-authed",
    limit: 600,
    windowMs: MINUTE_MS,
    subject: "user",
    description: "Read API — per-user, generous.",
  },

  /** Write API — POST/PUT/PATCH/DELETE. Per-user, half of read. */
  "write-authed": {
    id: "write-authed",
    limit: 300,
    windowMs: MINUTE_MS,
    subject: "user",
    description: "Write API — per-user.",
  },

  /** Webhook ingress (GitHub, Stripe, etc.). Per-IP — sources hit us
   *  from a fixed set of IPs and shouldn't burst beyond their published
   *  delivery rate. */
  "webhook-ingress": {
    id: "webhook-ingress",
    limit: 120,
    windowMs: MINUTE_MS,
    subject: "ip",
    description: "Inbound webhook deliveries — per-source-IP.",
  },

  /** Billing portal — expensive Stripe round-trip. Per-org, tight. */
  "billing-portal": {
    id: "billing-portal",
    limit: 20,
    windowMs: MINUTE_MS,
    subject: "org",
    description: "Stripe portal / checkout creation — per-org.",
  },
};

export function getPolicy(id: PolicyId): RateLimitPolicy {
  const p = POLICIES[id];
  if (!p) throw new Error(`rate-limit: unknown policy "${id}"`);
  return p;
}
