/**
 * @module server-github.service
 *
 * Per-server GitHub auth for self-hosted (desktop + remote servers). This is
 * the populator behind the `serverGithubAuth` / `githubDeployKey` tables and
 * the `resolveServerGitCredential` step in `clone-auth.ts`.
 *
 * A server can authenticate to GitHub for clone-on-server in one of three
 * modes (a per-server switch):
 *   - "token"          — a token minted by a gh device-login OR a pasted PAT,
 *                        stored encrypted; injected per clone like a PAT (the
 *                        "normal github token pipe"). After the one-time device
 *                        login there is NO live-gh dependency — we hold the
 *                        token, not a CLI session.
 *   - "ssh-server-key" — one Ed25519 key the operator adds to their GitHub
 *                        account; clones over git@github.com.
 *   - "ssh-deploy-key" — a per-repo read-only deploy key auto-registered via
 *                        the GitHub API.
 *
 * Everything here is self-hosted-only and hard-guards CLOUD_MODE (mirror
 * github.local-auth.ts). Secrets use the same encrypt/decrypt as the existing
 * clone-token pipe; they are decrypted only at deploy time and never logged.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { repos } from "@repo/db";
import { env } from "../../config/env";
import { encrypt, decrypt } from "../../lib/encryption";
import type { RequestContext } from "../../lib/request-context";
import { startServerDeviceFlow, getDeviceFlowStatus, cancelDeviceFlow } from "./github.local-auth";
import { ghFetchSoft } from "./github.http";
import { createDeployKey, revokeDeployKey } from "./github.service";
import { GITHUB_KNOWN_HOSTS } from "./github-known-hosts";
import type { BuildGitCredential } from "./clone-auth";

const execFileAsync = promisify(execFile);

const flowKey = (serverId: string) => `server:${serverId}`;

function assertSelfHosted(): void {
  if (env.CLOUD_MODE) {
    throw new Error("Per-server GitHub auth is only available on self-hosted instances");
  }
}

/** GitHub login for a token (display only). Soft — null on any failure. */
async function probeLogin(token: string): Promise<string | null> {
  const user = await ghFetchSoft<{ login?: string }>(token, { url: "https://api.github.com/user" });
  return user?.login ?? null;
}

/** Generate an Ed25519 keypair via ssh-keygen (OpenSSH private + public line). */
async function generateEd25519(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "opsh-ghkey-"));
  const keyPath = path.join(dir, "id_ed25519");
  try {
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], {
      timeout: 15_000,
    });
    const [priv, pub] = await Promise.all([
      readFile(keyPath, "utf8"),
      readFile(`${keyPath}.pub`, "utf8"),
    ]);
    return { privateKey: priv, publicKey: pub.trim() };
  } catch {
    throw new Error(
      "ssh-keygen is not available on this host — install openssh-client to use SSH-based GitHub auth",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── Populators (called from the controller) ─────────────────────────────────

/** Start a device-flow login for a server; on completion the token is stored
 *  encrypted (mode "token", source "device-flow"). Returns the verification. */
export async function startServerConnect(ctx: RequestContext, serverId: string) {
  assertSelfHosted();
  return startServerDeviceFlow(flowKey(serverId), async (token) => {
    const login = await probeLogin(token);
    await repos.serverGithubAuth.upsert({
      serverId,
      organizationId: ctx.organizationId,
      mode: "token",
      tokenEncrypted: encrypt(token),
      tokenSource: "device-flow",
      tokenLogin: login,
    });
  });
}

/** Poll the device flow — STATUS ONLY. The completed token is captured by the
 *  onComplete sink and stored encrypted server-side; it must never be returned
 *  to the client, so we strip it here (getDeviceFlowStatus includes it). */
export function pollServerConnect(
  serverId: string,
): { status: "waiting" | "complete" | "error"; error?: string } | null {
  const st = getDeviceFlowStatus(flowKey(serverId));
  if (!st) return null;
  return st.status === "error" ? { status: "error", error: st.error } : { status: st.status };
}

export function cancelServerConnect(serverId: string): void {
  cancelDeviceFlow(flowKey(serverId));
}

/** Store a pasted PAT for this server (validated against /user). */
export async function setServerToken(ctx: RequestContext, serverId: string, pat: string) {
  assertSelfHosted();
  const login = await probeLogin(pat);
  if (!login) throw new Error("That token could not authenticate to GitHub");
  await repos.serverGithubAuth.upsert({
    serverId,
    organizationId: ctx.organizationId,
    mode: "token",
    tokenEncrypted: encrypt(pat),
    tokenSource: "pat",
    tokenLogin: login,
  });
  return { login };
}

/** Generate (or return the existing) SSH server key. Public line is returned so
 *  the operator can add it to github.com/settings/keys. */
export async function ensureServerKey(ctx: RequestContext, serverId: string): Promise<{ publicKey: string }> {
  assertSelfHosted();
  const existing = await repos.serverGithubAuth.getByServer(serverId);
  if (existing?.mode === "ssh-server-key" && existing.serverKeyPublic) {
    return { publicKey: existing.serverKeyPublic };
  }
  const { privateKey, publicKey } = await generateEd25519(`openship-${serverId}`);
  await repos.serverGithubAuth.upsert({
    serverId,
    organizationId: ctx.organizationId,
    mode: "ssh-server-key",
    serverKeyPrivateEncrypted: encrypt(privateKey),
    serverKeyPublic: publicKey,
  });
  return { publicKey };
}

/** Switch a server to per-repo deploy-key mode (keys are minted lazily per repo
 *  at deploy time by `ensureDeployKey`). */
export async function setDeployKeyMode(ctx: RequestContext, serverId: string) {
  assertSelfHosted();
  await repos.serverGithubAuth.upsert({
    serverId,
    organizationId: ctx.organizationId,
    mode: "ssh-deploy-key",
  });
}

/** Ensure a deploy key exists for (server, owner, repo); register it read-only
 *  on GitHub the first time. Returns the decrypted private key for the clone. */
async function ensureDeployKey(
  ctx: RequestContext,
  serverId: string,
  organizationId: string,
  owner: string,
  repo: string,
): Promise<{ privateKey: string }> {
  const existing = await repos.githubDeployKey.getByRepo(serverId, owner, repo);
  if (existing) return { privateKey: decrypt(existing.privateKeyEncrypted) };

  const { privateKey, publicKey } = await generateEd25519(`openship-${serverId}-${owner}/${repo}`);
  // Register read-only. A 403 here means the resolved token lacks repo Admin —
  // surfaced to the operator (grant the App Administration permission or use a
  // repo-admin PAT).
  const key = await createDeployKey(
    ctx,
    owner,
    repo,
    `openship-${serverId.slice(0, 8)}`,
    publicKey,
    true,
  );
  await repos.githubDeployKey.create({
    serverId,
    organizationId,
    owner,
    repo,
    githubKeyId: key.id,
    privateKeyEncrypted: encrypt(privateKey),
    publicKey,
    readOnly: true,
  });
  return { privateKey };
}

// ─── Resolver (called by clone-auth.ts) ───────────────────────────────────────

/** The auth row shape these predicates need (a subset of `serverGithubAuth`). */
type ServerAuthRow = {
  mode: string;
  tokenEncrypted?: string | null;
  serverKeyPrivateEncrypted?: string | null;
};

/**
 * Does this row carry usable credential material? The ONE place that maps a mode
 * to the field it requires — the resolver, the preflight probe and the status
 * serializer all read it here, so adding a mode is a single edit rather than
 * three that can silently disagree.
 *
 * Deploy-key mode is "present" with no material: keys are minted lazily per repo
 * at deploy time (`ensureDeployKey`), so the GitHub call that could fail surfaces
 * there, not here.
 */
function hasStoredCredential(row: ServerAuthRow): boolean {
  if (row.mode === "token") return !!row.tokenEncrypted;
  if (row.mode === "ssh-server-key") return !!row.serverKeyPrivateEncrypted;
  if (row.mode === "ssh-deploy-key") return true;
  return false;
}

/**
 * Resolve a per-server GitHub credential for a clone that runs on `serverId`.
 * Returns null when the server has no config (fall through to the shared chain)
 * or in CLOUD_MODE. This is the function `clone-auth.ts` consults FIRST on the
 * remote branch.
 */
export async function resolveServerGitCredential(opts: {
  serverId: string;
  ctx: RequestContext;
  owner: string | null;
  repo: string | null;
}): Promise<BuildGitCredential | null> {
  if (env.CLOUD_MODE) return null;
  const row = await repos.serverGithubAuth.getByServer(opts.serverId);
  if (!row || !hasStoredCredential(row)) return null;

  if (row.mode === "token") {
    if (!row.tokenEncrypted) return null;
    try {
      return { token: decrypt(row.tokenEncrypted) };
    } catch {
      return null;
    }
  }

  if (row.mode === "ssh-server-key") {
    if (!row.serverKeyPrivateEncrypted) return null;
    try {
      return {
        ssh: {
          keyKind: "server-key",
          privateKey: decrypt(row.serverKeyPrivateEncrypted),
          knownHosts: GITHUB_KNOWN_HOSTS,
        },
      };
    } catch {
      return null;
    }
  }

  if (row.mode === "ssh-deploy-key") {
    if (!opts.owner || !opts.repo) return null;
    const { privateKey } = await ensureDeployKey(
      opts.ctx,
      opts.serverId,
      row.organizationId,
      opts.owner,
      opts.repo,
    );
    return { ssh: { keyKind: "deploy-key", privateKey, knownHosts: GITHUB_KNOWN_HOSTS } };
  }

  return null;
}

/**
 * Cheap existence check — "does this server have a usable GitHub credential?".
 * Same `hasStoredCredential` predicate the resolver gates on, without decrypting
 * or minting, so preflight reports the verdict the build will reach.
 */
export async function canResolveServerGitCredential(serverId: string): Promise<boolean> {
  if (env.CLOUD_MODE) return false;
  const row = await repos.serverGithubAuth.getByServer(serverId).catch(() => null);
  return !!row && hasStoredCredential(row);
}

// ─── Status + disconnect ──────────────────────────────────────────────────────

/** Masked status for the UI — never returns secret material. */
export async function getServerGithubStatus(serverId: string) {
  const row = await repos.serverGithubAuth.getByServer(serverId);
  const deployKeys = await repos.githubDeployKey.listByServer(serverId);
  if (!row) {
    return { mode: null, connected: false, deployKeyCount: deployKeys.length };
  }
  return {
    mode: row.mode,
    // Same predicate the resolver uses, plus the display-only requirement that
    // deploy-key mode has actually minted a key (the resolver counts it earlier,
    // since it mints on demand).
    connected:
      hasStoredCredential(row) && (row.mode !== "ssh-deploy-key" || deployKeys.length > 0),
    tokenSource: row.tokenSource ?? null,
    tokenLogin: row.tokenLogin ?? null,
    serverKeyPublic: row.serverKeyPublic ?? null,
    deployKeyCount: deployKeys.length,
    deployKeys: deployKeys.map((k) => ({ owner: k.owner, repo: k.repo, createdAt: k.createdAt })),
  };
}

/** Disconnect a server: revoke its GitHub deploy keys (best-effort) and delete
 *  all stored credential rows. */
export async function disconnectServerGithub(ctx: RequestContext, serverId: string): Promise<void> {
  assertSelfHosted();
  const deployKeys = await repos.githubDeployKey.listByServer(serverId);
  for (const k of deployKeys) {
    if (k.githubKeyId != null) {
      // Best-effort — a revoked/expired token or deleted repo shouldn't block
      // clearing our own state.
      await revokeDeployKey(ctx, k.owner, k.repo, k.githubKeyId).catch(() => {});
    }
  }
  await repos.githubDeployKey.deleteByServer(serverId);
  await repos.serverGithubAuth.deleteByServer(serverId);
}
