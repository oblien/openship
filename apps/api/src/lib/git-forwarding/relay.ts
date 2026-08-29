/**
 * Git credential relay — core. Desktop-only.
 *
 * Forwards the operator's LOCAL `gh` identity into a remote on demand, VS
 * Code-style — the remote never stores the token.
 *
 * Flow: a tiny helper script on the remote (configured as git's
 * `credential.helper`) opens a connection over an SSH *reverse* tunnel back to
 * this process and forwards git's credential request. This module answers with
 * `username=x-access-token` + the local `gh` token, for that one git operation.
 * The token lives only in the git process's memory on the remote; it is never
 * written to disk or env there.
 *
 * Control surface (the "controlled, secure" part):
 *   - desktop-only + explicit per-deploy opt-in (the deploy caller gates on both);
 *   - a per-session nonce the helper must present (rejects unauthenticated hits);
 *   - host pinned to github.com, protocol pinned to https;
 *   - repo pinned to the deploy's owner/repo (case-insensitive) — denies any other;
 *   - the reverse tunnel is open ONLY while the build is live (closed in finally);
 *   - per-relay rate limit + a structured log line per request (never the token).
 *
 * Inherent trust assumption (same as VS Code): while the tunnel is live, any
 * same-uid/root process on the remote that can read the 0700 helper script can
 * fetch the token (the gh token is account-wide, so the repo-pin is defense in
 * depth, not a hard wall). That is why this is desktop-only + opt-in per deploy.
 *
 * See ./README.md for the full design + the out-of-folder touch points.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import type { CommandExecutor } from "@repo/adapters";
import { sshManager } from "../ssh-manager";
import { getLocalGhToken } from "../../modules/github/github.local-auth";

/** Live relay handle, stored on the session and closed on teardown. */
export interface GitCredentialRelay {
  /** Remote loopback port the helper script connects to. */
  port: number;
  /** Per-session secret the helper presents on every request. */
  nonce: string;
  /** Tear down: close the reverse tunnel + release the SSH connection hold. */
  close: () => Promise<void>;
}

// Per-relay rate limit — a normal clone needs 1-2 requests; this bounds abuse
// from a rogue same-uid process hammering the loopback port.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Hard ceiling on a single request payload (nonce + a few small headers).
const MAX_REQUEST_BYTES = 8 * 1024;
// If a connection sends no complete request in time, drop it.
const REQUEST_TIMEOUT_MS = 10_000;

function log(
  result: string,
  meta: { serverId: string; sessionId: string; host?: string; owner?: string; repo?: string },
): void {
  // Never logs the token. One line per credential request.
  const parts = [
    `[git-relay] ${result}`,
    `server=${meta.serverId}`,
    `session=${meta.sessionId}`,
  ];
  if (meta.host) parts.push(`host=${meta.host}`);
  if (meta.owner) parts.push(`repo=${meta.owner}/${meta.repo ?? ""}`);
  console.log(parts.join(" "));
}

function nonceMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length-independent compare (timingSafeEqual requires equal lengths).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse the git credential request block (`key=value` lines) into a map. */
function parseRequest(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * POSIX-ish helper script (bash, for `/dev/tcp`) written to the remote. Holds NO
 * secret beyond the per-session nonce + the loopback port; both are scoped to a
 * single live session and the file is `0700` + removed on session close. git
 * invokes it as `<script> get`; it forwards git's request to the relay and pipes
 * the answer back.
 */
export function buildHelperScript(port: number, nonce: string): string {
  return [
    "#!/usr/bin/env bash",
    "# Openship git credential relay (desktop-only). No credential is stored here.",
    'if [ "$1" != "get" ]; then exit 0; fi',
    `exec 3<>/dev/tcp/127.0.0.1/${port} || exit 1`,
    `printf '%s\\n' '${nonce}' >&3`,
    "cat >&3", // forward git's request (ends with a blank line)
    "printf '\\n' >&3", // guarantee the blank-line terminator
    "cat <&3", // pipe the relay's answer back to git
  ].join("\n") + "\n";
}

/** Handle one reverse-tunnel connection from the remote helper script. */
function handleConnection(
  stream: Duplex,
  ctx: {
    serverId: string;
    sessionId: string;
    nonce: string;
    hits: number[];
    /** When both set, the relay serves creds ONLY for this exact repo
     *  (case-insensitive) — every other owner/repo is denied. */
    expectedOwner?: string;
    expectedRepo?: string;
  },
): void {
  let buf = "";
  let done = false;

  const finish = (response: string | null, result: string, meta?: { host?: string; owner?: string; repo?: string }) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    log(result, { serverId: ctx.serverId, sessionId: ctx.sessionId, ...meta });
    try {
      if (response) stream.write(response);
    } catch { /* peer gone */ }
    try { stream.end(); } catch { /* already closed */ }
  };

  const timer = setTimeout(() => finish(null, "timeout"), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  stream.on("error", () => finish(null, "stream-error"));
  stream.on("data", (chunk: Buffer) => {
    if (done) return;
    buf += chunk.toString("utf8");
    if (buf.length > MAX_REQUEST_BYTES) return finish(null, "oversize");

    // First line = nonce; the credential request follows, terminated by a blank line.
    const firstNl = buf.indexOf("\n");
    if (firstNl === -1) return; // nonce line incomplete
    const term = buf.indexOf("\n\n", firstNl);
    if (term === -1) return; // request not yet fully received

    const presented = buf.slice(0, firstNl).trim();
    if (!nonceMatches(presented, ctx.nonce)) return finish(null, "bad-nonce");

    // Rate limit (sliding window) — guards against a rogue local process.
    const now = Date.now();
    while (ctx.hits.length && now - ctx.hits[0] > RATE_LIMIT_WINDOW_MS) ctx.hits.shift();
    if (ctx.hits.length >= RATE_LIMIT_MAX) return finish(null, "rate-limited");
    ctx.hits.push(now);

    const req = parseRequest(buf.slice(firstNl + 1, term));
    const host = req.host ?? "";
    const pathParts = (req.path ?? "").replace(/\.git$/, "").split("/");
    const meta = { host, owner: pathParts[0] || undefined, repo: pathParts[1] || undefined };

    // Pin to github.com over https — never hand the identity to anything else.
    if (req.protocol !== "https" || host !== "github.com") {
      return finish(null, "host-denied", meta);
    }

    // Repo-pin (deploy): when the caller knows the exact repo (it always does for
    // a deploy clone), serve creds ONLY for that owner/repo. GitHub owner/repo are
    // case-insensitive. This is defense-in-depth — the gh token is account-wide,
    // so a same-uid attacker who reads the helper could still pose as this repo —
    // but it stops the relay from vending creds for any UNRELATED repo.
    if (ctx.expectedOwner && ctx.expectedRepo) {
      const ownerOk = meta.owner?.toLowerCase() === ctx.expectedOwner.toLowerCase();
      const repoOk = meta.repo?.toLowerCase() === ctx.expectedRepo.toLowerCase();
      if (!ownerOk || !repoOk) return finish(null, "repo-denied", meta);
    }

    void getLocalGhToken()
      .then((token) => {
        if (!token) return finish(null, "no-token", meta);
        // GitHub HTTPS token auth: it reads the token from either Basic-auth
        // slot and ignores the other value, so the username here is a label.
        // URL-form auth picks the pair GitHub documents per token type —
        // see gitCredentialPair (packages/adapters/src/runtime/git-clone.ts);
        // this is the credential-helper protocol, not a URL, so it stays put.
        finish(`username=x-access-token\npassword=${token}\n\n`, "granted", meta);
      })
      .catch(() => finish(null, "token-error", meta));
  });
}

/**
 * Open a credential relay for a session. Both remote executors host the reverse
 * tunnel: ssh2 (`SshExecutor`, in-process channels) and system-ssh
 * (`SystemSshExecutor`, `ssh -O forward -R` over the ControlMaster — agent
 * auth). Returns `null` only when the executor exposes no `reverseForward` at
 * all (e.g. `LocalExecutor`, which never needs a relay) — forwarding then
 * cleanly no-ops and the caller proceeds without it.
 */
export async function openRelay(opts: {
  serverId: string;
  sessionId: string;
  /**
   * Repo-pin: when both are set, the relay serves credentials ONLY for this
   * exact `owner/repo` (case-insensitive) and denies any other repo. Deploys
   * always know their repo up front; omit for an unscoped (host-pinned) relay.
   */
  expectedOwner?: string;
  expectedRepo?: string;
}): Promise<GitCredentialRelay | null> {
  const executor = await sshManager.acquire(opts.serverId);
  if (typeof executor.reverseForward !== "function") return null; // no tunnel (e.g. LocalExecutor)

  sshManager.retain(opts.serverId);
  const nonce = randomBytes(32).toString("base64url");
  const hits: number[] = [];

  let forward: { port: number; close: () => Promise<void> };
  try {
    forward = await executor.reverseForward((stream) =>
      handleConnection(stream, {
        serverId: opts.serverId,
        sessionId: opts.sessionId,
        nonce,
        hits,
        expectedOwner: opts.expectedOwner,
        expectedRepo: opts.expectedRepo,
      }),
    );
  } catch (err) {
    sshManager.release(opts.serverId);
    throw err;
  }

  // `close` is idempotent (a `closed` guard) so a double-call can't
  // double-release the SSH retain and corrupt the pool's hold count.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await forward.close().catch(() => {});
    sshManager.release(opts.serverId);
  };

  return { port: forward.port, nonce, close };
}

/**
 * Write the 0700 credential-helper script to the remote and return its absolute
 * path. Used by the deploy relay. The script holds no secret beyond the per-session
 * nonce + loopback port.
 */
export async function writeHelperScript(
  executor: CommandExecutor,
  sessionId: string,
  port: number,
  nonce: string,
): Promise<string> {
  const home = (await executor.exec('printf %s "$HOME"')).trim();
  if (!home) throw new Error("could not resolve remote $HOME");
  const scriptPath = `${home}/.openship/cred-${sessionId}.sh`;
  await executor.writeFile(scriptPath, buildHelperScript(port, nonce));
  // The caller only learns scriptPath on success, so its teardown can't remove a
  // partial write. If chmod (a separate SSH channel) fails after the file landed,
  // clean it up here before rethrowing — never leave an orphaned helper on disk.
  try {
    await executor.exec(`chmod 700 "${scriptPath}"`);
  } catch (err) {
    await Promise.resolve(executor.rm(scriptPath)).catch(() => {});
    throw err;
  }
  return scriptPath;
}
