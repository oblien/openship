/**
 * GitHub source acquisition via tarball download — the clone-free alternative
 * to `git clone`.
 *
 * GitHub serves any ref as a tarball (`/repos/{owner}/{repo}/tarball/{ref}`,
 * which 302-redirects to a signed codeload URL). Downloading + extracting it on
 * the target server gives the tracked source tree in place — no git, no history,
 * no `.git`, and (for a docker server build) NO orchestrator clone and NO context
 * transfer. `git archive --remote` is refused by GitHub, so this is the way.
 *
 * The caller is expected to fall back to `git clone` when `githubTarballUrl`
 * returns null (non-github / non-https remote) or `downloadTarballOnRemote`
 * throws (private repo without a token, curl/tar missing, network error).
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { CommandExecutor, LogEntry } from "../types";
import { sq } from "./build-pipeline";

/**
 * Map a GitHub HTTPS remote to its tarball endpoint for `ref`. Returns null for
 * non-github or non-https remotes (`ssh://`, `git@…`) — the caller then clones.
 * `ref` should be a commit SHA (resolves any commit directly, so there's no
 * shallow-clone depth/unshallow dance) or a branch name.
 */
export function githubTarballUrl(repoUrl: string, ref: string): string | null {
  if (!repoUrl || !ref) return null;
  const m = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo) return null;
  return `https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`;
}

export interface DownloadTarballOptions {
  url: string;
  /** GitHub token for a private repo; omit for a public repo (anonymous). */
  token?: string;
  /** Remote directory to extract the tree into (recreated fresh). */
  destDir: string;
  onLog?: (log: LogEntry) => void;
  signal?: AbortSignal;
}

/**
 * Download a GitHub source tarball ON THE REMOTE host and extract it into
 * `destDir`, stripping the `owner-repo-sha/` wrapper directory.
 *
 * Uses a temp file rather than a `curl | tar` pipe on purpose: `dash` has no
 * `pipefail`, so a piped `curl` failure would be masked by `tar` succeeding on a
 * partial stream. With `-f` (fail on HTTP error) + `&&`, a 404/403/network error
 * reliably surfaces a non-zero exit → the caller falls back to git clone. Throws
 * on any non-zero exit.
 */
export async function downloadTarballOnRemote(
  executor: CommandExecutor,
  opts: DownloadTarballOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const dest = sq(opts.destDir);
  const tmp = sq(`${opts.destDir}.opsh-src.tar.gz`);
  // Token via env keeps it out of curl's argv. The command still travels to the
  // server, but that's the same exposure as today's tokenized clone URL.
  const authExport = opts.token ? `export OPSH_GH_TOK=${sq(opts.token)}; ` : "";
  const authHeader = opts.token ? `-H "Authorization: Bearer $OPSH_GH_TOK" ` : "";
  const cmd =
    `rm -rf ${dest} ${tmp} && mkdir -p ${dest} && ${authExport}` +
    `curl -fSL --retry 3 --retry-delay 2 ${authHeader}-o ${tmp} ${sq(opts.url)} && ` +
    `tar -xzf ${tmp} --strip-components=1 -C ${dest} && rm -f ${tmp}`;

  try {
    const { code } = await executor.streamExec(cmd, (entry) => opts.onLog?.(entry), { signal: opts.signal });
    opts.signal?.throwIfAborted();
    if (code !== 0) throw new Error(`tarball download exited with code ${code}`);
  } catch (error) {
    // The partial archive is beside the context, so removing the context alone
    // cannot reclaim it. Cleanup must also work inside an aborted caller scope.
    const cleanup = () => executor.exec(`rm -f ${tmp}`, { timeout: 10_000 });
    await (executor.runWithAbortSignal
      ? executor.runWithAbortSignal(AbortSignal.timeout(10_000), cleanup)
      : cleanup()).catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/runtime/source-tarball");
      });
    throw error;
  }
}
