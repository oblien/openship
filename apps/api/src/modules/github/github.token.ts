/**
 * @module github.token
 *
 * THE single source of truth for "what GitHub token do I use for this
 * action?". Every place in the codebase that needs a token reaches into
 * `tokenFor(ctx, purpose, tokenCtx)` and that's the whole answer.
 *
 * Two purposes. That's it.
 *
 * ─── purpose: "local" ───────────────────────────────────────────────
 *
 *   The token stays on THIS machine. Used for:
 *     - Repo + org listing
 *     - Reading file contents / branches
 *     - Local-build clones (clone runs on this API host)
 *     - Generic GitHub API calls
 *
 *   Self-hosted priority (for purpose="local" — see ordering rationale
 *   block at the dispatcher):
 *     1. gh CLI                ← least config: just needs the operator's
 *                                 CLI present; opt-in gated for multi-user
 *     2. Openship App installation (org-scoped, short-lived, repo-scoped)
 *     3. Project clone token   (per-project user PAT override)
 *     4. User-global clone token (user PAT, when marked as default)
 *     5. User OAuth (Better-Auth)
 *     6. null
 *
 *   SaaS priority:
 *     1. Project clone token
 *     2. User-global clone token
 *     3. Openship App installation
 *     4. User OAuth
 *     5. null
 *
 * ─── purpose: "remote" ──────────────────────────────────────────────
 *
 *   The token RIDES OFF this machine to a remote build worker / cloud
 *   workspace. Used for:
 *     - Remote-build clones (cloud workspace clones the repo)
 *
 *   Safest tokens only. **gh CLI is REFUSED** — it's the instance operator's
 *   long-lived, account-wide credential, and shipping it to a box they may not
 *   solely control is a real security hole.
 *
 *   Self-hosted:
 *     1. Project clone token
 *     2. User-global clone token
 *     3. Openship App installation (short-lived, repo-scoped)
 *     4. null  ← caller throws "install App or set per-project token"
 *
 *   SaaS: same, plus a `user-oauth` tail. That token is scoped to the one user
 *   and the worker is Openship's own cloud workspace, so the boundary the gh-cli
 *   refusal protects doesn't apply. (This paragraph used to claim SaaS remote
 *   ended at null; `tokenFor.test.ts` has always asserted otherwise.)
 *
 * The dispatcher returns `{ token, source }` so callers (logging,
 * audit, metrics) know exactly which step in the chain matched. The
 * full priority chain lives here and ONLY here.
 */

import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { env } from "../../config/env";
import { decrypt } from "../../lib/encryption";
import {
  getInstallationId,
  getInstallationIdByOrg,
  getInstallationToken,
  getUserToken,
} from "./github.auth";
// gh-CLI (github.local-auth) is imported DYNAMICALLY at its two self-hosted
// "local"-purpose call sites below, so the gh module never loads in CLOUD_MODE.
import { canUseGitHubRepo } from "./github-access";
import type { RequestContext } from "../../lib/request-context";

// ─── Public types ───────────────────────────────────────────────────────────

export type GitHubPurpose = "local" | "remote";

export type GitHubTokenSource =
  | "project"          // per-project clone_token_encrypted
  | "user-pat"         // user_settings clone_token_encrypted (cloneTokenAsDefault=true)
  | "gh-cli"           // local gh CLI token
  | "app-installation" // Openship App installation token (short-lived, scoped)
  | "user-oauth";      // Better-Auth GitHub OAuth (rare fallback)

export interface TokenResult {
  token: string;
  source: GitHubTokenSource;
}

/**
 * Per-token-call data — owner, installation id, project id. Identity
 * (userId, organizationId) lives in the RequestContext passed alongside,
 * NOT in this interface.
 */
export interface TokenContext {
  /** Repo owner — required for App installation token resolution. */
  owner?: string;
  /** Repo name — enables PER-REPO authorization in the github-access
   *  gate. When set, the gate authorizes this exact repo; when absent it
   *  falls back to owner-level authorization (any grant under the owner). */
  repo?: string;
  /** Override the installation id (rare; usually inferred from owner). */
  installationId?: number;
  /** Project id — for per-project clone token lookup. */
  projectId?: string;
  /** Target server id — threaded so `canResolveTokenFor` (preflight) can stay
   *  in lockstep with a per-server credential consulted upstream in
   *  clone-auth.ts. `tokenFor` itself has no per-server branch (SSH can't be a
   *  TokenResult); this is plumbing for parity, not resolution. */
  serverId?: string;
}

// ─── The dispatcher ─────────────────────────────────────────────────────────

/**
 * Resolve a GitHub token for the given purpose. Side-effect free —
 * only DB reads + decrypt + (optionally) an installation token mint.
 * Returns null when every chain step came up empty; callers decide
 * whether to throw or proceed (use `requireTokenFor` for the throw).
 */
/* ─── The chain, as data ──────────────────────────────────────────────────────
 *
 * Every credential is ONE spec, and every platform×purpose is ONE ordered list of
 * spec names. Both `tokenFor` (which mints) and `canResolveTokenFor` (which only
 * probes) walk the SAME list.
 *
 * That sameness is the point. The two used to be hand-mirrored chains in separate
 * functions, and keeping them in step was enforced only by a drift-guard test —
 * i.e. drift was possible by construction and merely detected afterwards. Adding
 * a credential kind meant editing four inline chains and hoping. Now a new kind is
 * one spec plus its place in the table, and preflight cannot disagree with the
 * real resolution because there is only one order to disagree with.
 */

/** What a chain step needs. Assembled once per call so specs stay pure reads. */
interface ChainCtx {
  ctx: RequestContext;
  userId: string;
  organizationId?: string;
  purpose: GitHubPurpose;
  tokenCtx: TokenContext;
  /**
   * The 0-bypass permission verdict for the App branch, resolved ONCE up front.
   * Both the mint and the probe consume the same value, so preflight can never
   * report "App available" for a repo the real mint will refuse.
   */
  installationAllowed: boolean;
}

interface CredentialSpec {
  kind: GitHubTokenSource;
  /**
   * May this credential's material LEAVE this host?
   *
   * A property of the credential, not of the caller. `gh-cli` is a long-lived
   * broad-scope user token, so shipping it to a build worker is a real hole — it
   * is therefore absent from every "remote" chain below rather than special-cased
   * mid-resolution. Encoding it here means a future credential kind cannot be
   * added to a remote chain without someone stating this explicitly.
   */
  shippable: boolean;
  /** Mint or read the real token. */
  resolve(c: ChainCtx): Promise<string | null>;
  /** Cheap "would this match?" — no mint, no JWT exchange. */
  probe(c: ChainCtx): Promise<boolean>;
}

export const SPECS: Record<GitHubTokenSource, CredentialSpec> = {
  "gh-cli": {
    kind: "gh-cli",
    shippable: false,
    resolve: async (c) => {
      // HIGH #7 — the whole "may this caller use the operator's broad token here"
      // policy lives in mayUseOperatorCliToken; this step is just "take it if so".
      if (!(await mayUseOperatorCliToken(c.userId, c.organizationId, c.purpose))) return null;
      // Dynamic import: only ever reached off the SaaS (no gh-cli in any cloud
      // chain), so the gh module never loads there.
      const { getLocalGhToken } = await import("./github.local-auth");
      return getLocalGhToken();
    },
    probe: async (c) => Boolean(await SPECS["gh-cli"].resolve(c).catch(() => null)),
  },

  "app-installation": {
    kind: "app-installation",
    shippable: true, // short-lived + repo-scoped: safe to hand to a build worker
    resolve: async (c) => {
      if (!c.tokenCtx.owner || !c.installationAllowed) return null;
      return tryInstallationToken(c.ctx, c.tokenCtx.owner, c.tokenCtx.installationId);
    },
    probe: async (c) => {
      if (!c.tokenCtx.owner || !c.installationAllowed) return false;
      // Existence of the installation ROW only — skips the ~200-500ms JWT +
      // token exchange that resolve() pays.
      let installId: number | null = null;
      if (c.organizationId) {
        installId = await getInstallationIdByOrg(c.organizationId, c.tokenCtx.owner).catch(
          () => null,
        );
      }
      if (!installId) {
        installId = await getInstallationId(c.ctx, c.tokenCtx.owner).catch(() => null);
      }
      return Boolean(installId);
    },
  },

  project: {
    kind: "project",
    shippable: true, // the user opted in by pasting it
    resolve: async (c) =>
      c.tokenCtx.projectId ? readProjectToken(c.tokenCtx.projectId) : null,
    probe: async (c) => {
      if (!c.tokenCtx.projectId) return false;
      const project = await repos.project.findById(c.tokenCtx.projectId).catch(() => null);
      return Boolean(project?.cloneTokenEncrypted);
    },
  },

  "user-pat": {
    kind: "user-pat",
    shippable: true, // same reasoning as `project`
    resolve: async (c) => readUserGlobalToken(c.userId),
    probe: async (c) => {
      const settings = await repos.settings.findByUser(c.userId).catch(() => null);
      return Boolean(settings?.cloneTokenEncrypted && settings.cloneTokenAsDefault);
    },
  },

  "user-oauth": {
    kind: "user-oauth",
    /**
     * Shippable, and the distinction from `gh-cli` is the interesting part:
     * `shippable` is really "may this go to a build worker WE hand it to". A user
     * OAuth token is scoped to that one user and is only ever shipped to Openship's
     * own cloud workspace (SaaS remote — asserted by tokenFor.test.ts). The gh-cli
     * token is the INSTANCE OPERATOR's account-wide credential travelling to a box
     * the operator may not solely control; that is the hole. Same word, genuinely
     * different blast radius.
     */
    shippable: true,
    resolve: async (c) => getUserToken(c.userId),
    probe: async (c) => Boolean(await getUserToken(c.userId).catch(() => null)),
  },
};

/**
 * WHAT IS AVAILABLE WHERE — the whole platform policy, in one readable table.
 *
 * This replaces mode checks (`env.CLOUD_MODE`, `isSelfHostedLocal`,
 * `getGitHubAuthMode`) interleaved through four inline branches. A dead gate hid
 * inside one of those branches for a long time precisely because "what applies on
 * this platform" was not stated anywhere you could read it.
 *
 *   saas       — the App is the only auto-resolved source; there is no `gh` on a
 *                multi-tenant host, ever. Explicit PATs still win at the top:
 *                they are user provisioning, and the SaaS has no other way into a
 *                repo the App isn't installed on. Purpose is irrelevant here —
 *                every SaaS credential is already shippable.
 *   selfhosted — purpose matters. For a LOCAL clone prefer auto-resolved
 *                credentials (tighter scope, less maintenance) over pasted PATs.
 *                For a REMOTE clone the chain contains only `shippable` kinds.
 */
type GitHubPlatform = "saas" | "selfhosted";

export const CHAINS: Record<GitHubPlatform, Record<GitHubPurpose, GitHubTokenSource[]>> = {
  saas: {
    local: ["project", "user-pat", "app-installation", "user-oauth"],
    remote: ["project", "user-pat", "app-installation", "user-oauth"],
  },
  selfhosted: {
    // gh-cli first: least configuration, and it reaches any repo the operator's
    // account can see, whereas the App needs an install on that owner.
    local: ["gh-cli", "app-installation", "project", "user-pat", "user-oauth"],
    // No gh-cli (not shippable) and deliberately no OAuth tail either.
    remote: ["project", "user-pat", "app-installation"],
  },
};

/**
 * STRUCTURAL INVARIANT, asserted at module load: no "remote" chain may contain a
 * credential whose material must not leave this host.
 *
 * "Remote refuses gh-cli" used to be an `if` buried in the resolution path. As a
 * check over the table it now covers credentials that don't exist yet: adding a
 * non-shippable kind to a remote chain fails at import, not in production after
 * someone ships an operator's broad-scope token to a build worker.
 */
for (const [platform, byPurpose] of Object.entries(CHAINS)) {
  for (const kind of byPurpose.remote) {
    if (!SPECS[kind].shippable) {
      throw new Error(
        `GitHub credential chain misconfigured: "${kind}" is not shippable but appears ` +
          `in the ${platform}/remote chain. A remote build ships the credential off ` +
          `this host — only shippable kinds belong there.`,
      );
    }
  }
}

function platformFor(): GitHubPlatform {
  return env.CLOUD_MODE ? "saas" : "selfhosted";
}

/** The ordered specs for this platform + purpose. */
function chainFor(purpose: GitHubPurpose): CredentialSpec[] {
  return CHAINS[platformFor()][purpose].map((kind) => SPECS[kind]);
}

/**
 * Build the shared context once — notably the single `canUseGitHubRepo` call, so
 * the mint and the probe are answering the same permission question.
 */
async function chainCtx(
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext,
): Promise<ChainCtx> {
  // ── 0-bypass permission gate: GitHub access is default-DENY for everyone but
  //    the org OWNER. Admins/members/restricted can use the org's App
  //    installation only when the owner granted them this repo (or its
  //    installation, or all-GitHub). Denied → the App step yields nothing and the
  //    chain falls through to the caller's OWN PAT/OAuth (or null → "connect your
  //    GitHub"). This is THE funnel: every mint passes here, so there is no door
  //    around it.
  const installationAllowed = tokenCtx.owner
    ? await canUseGitHubRepo(
        ctx,
        {
          owner: tokenCtx.owner,
          repo: tokenCtx.repo,
          installationId: tokenCtx.installationId,
        },
        "read",
      )
    : false;
  return {
    ctx,
    userId: ctx.userId,
    organizationId: ctx.organizationId || undefined,
    purpose,
    tokenCtx,
    installationAllowed,
  };
}

/**
 * Resolve a GitHub token for the given purpose. Side-effect free —
 * only DB reads + decrypt + (optionally) an installation token mint.
 * Returns null when every chain step came up empty; callers decide
 * whether to throw or proceed (use `requireTokenFor` for the throw).
 */
export async function tokenFor(
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext = {},
): Promise<TokenResult | null> {
  const c = await chainCtx(ctx, purpose, tokenCtx);
  for (const spec of chainFor(purpose)) {
    const token = await spec.resolve(c);
    if (token) return { token, source: spec.kind };
  }
  return null;
}

/**
 * Fast existence check — "could `tokenFor` resolve a token if we asked
 * it to?". Skips the actual installation-token mint (JWT + GitHub API
 * exchange, ~200-500ms) which `tokenFor` does for the App branch; this
 * version only confirms the installation ROW exists in our DB.
 *
 * Use this in preflight where minting is wasteful — the real mint
 * happens later in the build pipeline when we actually need the token.
 *
 * Returns the source that WOULD be matched, or null if none would. Walks the
 * SAME chain as `tokenFor`, so the two cannot report different sources.
 */
export async function canResolveTokenFor(
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext = {},
): Promise<GitHubTokenSource | null> {
  const c = await chainCtx(ctx, purpose, tokenCtx);
  for (const spec of chainFor(purpose)) {
    if (await spec.probe(c)) return spec.kind;
  }
  return null;
}

/**
 * Same as `tokenFor`, but throws an actionable AppError when nothing
 * can be resolved. Use this at deploy/clone entry points where missing
 * credentials are a real "do something" condition.
 */
export async function requireTokenFor(
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext = {},
): Promise<TokenResult> {
  const r = await tokenFor(ctx, purpose, tokenCtx);
  if (r) return r;

  const hint =
    purpose === "remote"
      ? "Install the Openship GitHub App on this owner, or set a per-project clone token in Settings."
      : "Run `gh auth login`, connect Openship Cloud, or set a per-project clone token in Settings.";

  throw new AppError(
    `No GitHub token available for ${tokenCtx.owner ?? "this request"} (purpose: ${purpose}). ${hint}`,
    403,
    purpose === "remote" ? "GITHUB_REMOTE_TOKEN_REQUIRED" : "GITHUB_TOKEN_REQUIRED",
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * HIGH #7 — single source of truth for "can this caller use the gh CLI
 * operator token?". Two ways in:
 *
 *   1. `env.GITHUB_AUTH_MODE === "cli"` — operator explicitly chose CLI
 *      mode for this whole instance. No further gating needed.
 *   2. `user_settings.ghCliOperatorOptedIn === true` — the user is the
 *      single-user instance operator and has flipped the opt-in. Any
 *      other caller (member, admin, owner-of-other-org) is refused.
 *
 * Returns false on lookup failure (fail closed).
 */
async function isCliOperatorAllowed(userId: string): Promise<boolean> {
  if (env.GITHUB_AUTH_MODE === "cli") return true;
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  return settings?.ghCliOperatorOptedIn === true;
}

/**
 * The gh-CLI authorization GATE, split out of token resolution so "which
 * token do I pick" (the priority chains above) and "is this caller allowed
 * to use the operator's broad CLI token here" are separate concerns.
 *
 *   - purpose "remote" → NEVER. The gh CLI token is a long-lived,
 *     broad-scope user PAT; shipping it off this host to a remote build
 *     worker is a real security hole (HIGH #7).
 *   - no org context (zero-auth desktop / internal jobs) → YES. The
 *     auto-provisioned local user IS the operator.
 *   - org context → only if the operator opted in (`isCliOperatorAllowed`),
 *     so a non-operator member can't borrow the operator's token.
 *
 * NOTE: this gate is for CLONE/BUILD token resolution only. Plain repo/org
 * LISTING is a local read and uses the gh token DIRECTLY via the
 * github.local-auth helpers (`listLocalGhRepos`/`listLocalGhOrgs`) — it
 * deliberately never passes through here.
 */
async function mayUseOperatorCliToken(
  userId: string,
  organizationId: string | undefined,
  purpose: GitHubPurpose,
): Promise<boolean> {
  if (purpose === "remote") return false;
  if (!organizationId) return true;
  return isCliOperatorAllowed(userId);
}

/**
 * Mint a GitHub App installation token, but LOG (without the token) when
 * the mint fails before falling through to the next credential. A 403
 * (install suspended / permissions revoked / repo no longer covered) would
 * otherwise be silently downgraded to a broader user PAT / OAuth token with
 * no trace — masking a security-relevant signal. Returns null on failure so
 * the priority chain continues unchanged.
 */
async function tryInstallationToken(
  ctx: RequestContext,
  owner: string,
  installationId?: number,
): Promise<string | null> {
  try {
    return await getInstallationToken(ctx, owner, installationId);
  } catch (err) {
    console.warn(
      `[github.token] App installation token mint failed for owner=${owner}` +
        `${installationId ? ` install=${installationId}` : ""}: ` +
        `${(err as Error).message} — falling through to the next credential`,
    );
    return null;
  }
}

async function readProjectToken(projectId: string): Promise<string | null> {
  const project = await repos.project.findById(projectId).catch(() => null);
  if (!project?.cloneTokenEncrypted) return null;
  try {
    return decrypt(project.cloneTokenEncrypted);
  } catch {
    return null;
  }
}

async function readUserGlobalToken(userId: string): Promise<string | null> {
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  if (!settings?.cloneTokenEncrypted) return null;
  if (!settings.cloneTokenAsDefault) return null;
  try {
    return decrypt(settings.cloneTokenEncrypted);
  } catch {
    return null;
  }
}
