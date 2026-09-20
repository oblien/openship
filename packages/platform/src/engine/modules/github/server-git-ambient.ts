/**
 * @module server-git-ambient
 *
 * "Can this server clone this repo BY ITSELF?"
 *
 * A build host is often already authenticated to the git remote: the operator ran
 * `gh auth login` on it, or configured a credential helper, or its ssh key is on
 * the account. Openship used to ignore all of that — it only knew about
 * credentials it stores itself (`serverGithubAuth`) or ships/forwards — so such a
 * server was treated as credential-less and the deploy fell back to cloning on
 * the API host and transferring the build context.
 *
 * This module closes that gap, and it is the narrowest credential path we have:
 *   - nothing is shipped TO the server (no token in a URL, no key written), and
 *   - nothing is read back OFF it (we never run `gh auth token`'s output into a
 *     variable, never `git credential fill`, never read `~/.git-credentials`) —
 *     every probe discards stdout and we keep only the exit status.
 * The credential never crosses the wire in either direction; git on the server
 * resolves it locally at clone time.
 *
 * Verification is the same operation the build will perform (`git ls-remote` for
 * THIS repo, assembled by the shared `assembleGitClone`), so a server whose `gh`
 * is logged in as an account without access to this repo reports "no" here rather
 * than failing mid-build. That's what makes it safe to prefer over the api-host
 * fallback without changing the outcome of any deploy that already works.
 */

import { assembleGitClone, sq, type AmbientGitVia, type CommandExecutor } from "@repo/adapters";

/** Probe budget. A reachable remote answers `ls-remote` in well under this. */
const DISCOVER_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 30_000;

/**
 * One shell round-trip that reports which auth mechanisms EXIST on the host.
 * Every branch discards output and yields only a flag — in particular
 * `gh auth token` is redirected to /dev/null and used purely as an exit-status
 * check, so the token is never transferred to us.
 */
const DISCOVER_SCRIPT = [
  'command -v git >/dev/null 2>&1 && echo git=1 || echo git=0',
  'command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1 && echo gh=1 || echo gh=0',
  '[ -n "$(git config --get credential.helper 2>/dev/null)" ] && echo helper=1 || echo helper=0',
  '[ -s "$HOME/.git-credentials" ] && echo credfile=1 || echo credfile=0',
  'ls "$HOME"/.ssh/id_* >/dev/null 2>&1 && echo sshkey=1 || echo sshkey=0',
].join("; ");

function flag(out: string, name: string): boolean {
  // Tolerant of CRLF and of an executor that pads the stream.
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(`${name}=1`);
}

/**
 * What the probe found. `"anonymous"` means the remote needs NO credential at
 * all (a public repo) — kept distinct from the ambient mechanisms because the
 * clone then carries nothing, not even the host's own helper.
 */
export type ProbedGitVia = "anonymous" | AmbientGitVia;

export interface AmbientGitProbe {
  via: ProbedGitVia;
}

/**
 * Detect and VERIFY the server's own git access to `repoUrl`.
 *
 * Returns the mechanism that actually worked, or null when the server can't
 * reach the repo on its own (the caller then keeps its existing fallback).
 * Never throws: any executor/network failure means "no".
 */
export async function probeServerGitAccess(opts: {
  executor: Pick<CommandExecutor, "exec">;
  repoUrl: string;
  /** Optional sink for build-log breadcrumbs. Never receives secret material. */
  onLog?: (message: string) => void;
}): Promise<AmbientGitProbe | null> {
  if (!opts.repoUrl) return null;

  let discovered: string;
  try {
    discovered = await opts.executor.exec(DISCOVER_SCRIPT, { timeout: DISCOVER_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!flag(discovered, "git")) return null;

  // ALWAYS try no-credential access first, whatever the host has: if the repo is
  // public the clone needs nothing, and attempting it is both cheaper and more
  // truthful than asking GitHub's API whether it's public (that probe is
  // unauthenticated, rate-limited 60/hr/IP and fails closed, so it reports a
  // public repo as private the moment the budget runs out or the network
  // hiccups). `git ls-remote` from the machine that will actually clone is the
  // authority. Then the host's own credentials, most specific first.
  const candidates: ProbedGitVia[] = ["anonymous"];
  if (flag(discovered, "gh")) candidates.push("gh");
  if (flag(discovered, "helper") || flag(discovered, "credfile")) candidates.push("helper");
  if (flag(discovered, "sshkey")) candidates.push("ssh");

  for (const via of candidates) {
    // "anonymous" assembles with NO credential and with the host's credential
    // helper DISABLED, so success proves genuine unauthenticated access rather
    // than silently borrowing whatever the box had lying around.
    const { cloneUrl, gitEnv, credFlag } =
      via === "anonymous"
        ? assembleGitClone({ repoUrl: opts.repoUrl })
        : assembleGitClone({ repoUrl: opts.repoUrl, ambient: { via } });
    // ls-remote is the same auth path the clone takes. Output is discarded — we
    // only want the exit status, and the ref list is noise in a build log.
    const cmd = `${gitEnv} git ${credFlag} ls-remote ${sq(cloneUrl)} HEAD >/dev/null 2>&1`;
    try {
      await opts.executor.exec(cmd, { timeout: VERIFY_TIMEOUT_MS });
      opts.onLog?.(
        via === "anonymous"
          ? "The build server can read this repo with no credential — cloning there directly."
          : `The build server can reach this repo with its own git credentials (${via}).`,
      );
      return { via };
    } catch {
      // Not public, wrong account, or that mechanism isn't really wired up.
    }
  }

  return null;
}
