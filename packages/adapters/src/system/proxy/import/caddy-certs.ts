/**
 * Read a cert out of Caddy's own certificate store.
 *
 * Caddy auto-provisions HTTPS, so the overwhelmingly common Caddyfile declares no
 * cert paths at all — which is why the config parsers can't surface one and why a
 * Caddy box previously ALWAYS fell through to a fresh ACME issuance on migrate,
 * even though a perfectly good cert was sitting on disk. The store is the only
 * place that cert exists.
 *
 * Layout (Caddy's certmagic):
 *   <data>/certificates/<ca-directory-host>/<name>/<name>.crt
 *                                                 /<name>.key
 * where `<name>` is the domain, and a wildcard is stored as `wildcard_.example.com`.
 * `<data>` is XDG_DATA_HOME/caddy — /var/lib/caddy/.local/share/caddy under the
 * systemd unit, /root/.local/share/caddy when run as root, and /data/caddy in the
 * official Docker image (which sets XDG_DATA_HOME=/data).
 */

import type { CommandExecutor } from "../../../types";
import { containerCommand, readMaybeInContainer } from "../../edge-container-executor";
import { tryExec } from "./parse-utils";

/** Data roots to search, in priority order. Container paths are tried last. */
const CADDY_DATA_ROOTS = [
  "/var/lib/caddy/.local/share/caddy",
  "/root/.local/share/caddy",
  "/home/caddy/.local/share/caddy",
  "/data/caddy",
];

/**
 * Store directory names that could hold a cert for `host`: the host itself, and
 * the wildcard that covers it one label up (`a.example.com` →
 * `wildcard_.example.com`). Certmagic sanitizes `*` to `wildcard_`.
 */
function candidateNames(host: string): string[] {
  const names = [host];
  const dot = host.indexOf(".");
  if (dot > 0) names.push(`wildcard_${host.slice(dot)}`);
  return names;
}

/**
 * Locate the `.crt`/`.key` pair for `host` under one data root. Globs the CA
 * directory level (`certificates/*`) because it's named after the ACME endpoint
 * (`acme-v02.api.letsencrypt.org-directory`, or a staging/ZeroSSL variant) and we
 * shouldn't care which CA issued it. `ls` rather than `find` — busybox in the
 * Caddy image has no useful `find -path`.
 */
async function findPairIn(
  exec: CommandExecutor,
  root: string,
  host: string,
  container?: string | null,
): Promise<{ certPath: string; keyPath: string } | null> {
  for (const name of candidateNames(host)) {
    const glob = `${root}/certificates/*/${name}/${name}.crt`;
    // A miss can present as either a non-zero exit OR empty stdout depending on the
    // shell (an unmatched glob is passed through literally to `ls`, and `nullglob`
    // changes what that does), so BOTH count as "look in the container next" —
    // keying only off the exit code silently skipped the container leg.
    let certPath = firstCrt(await tryExec(exec, `ls -1 ${glob} 2>/dev/null`));
    if (!certPath && container) {
      certPath = firstCrt(
        await tryExec(exec, containerCommand(container, `ls -1 ${glob} 2>/dev/null`)),
      );
    }
    if (certPath) return { certPath, keyPath: certPath.replace(/\.crt$/, ".key") };
  }
  return null;
}

/** First `.crt` line in an `ls -1` listing. */
function firstCrt(listing: string | null): string | undefined {
  return (listing ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith(".crt"));
}

/**
 * The PEM pair Caddy currently serves for `host`, or null. Never throws — a
 * missing store is a normal answer, not a failure.
 */
export async function caddyStoreCert(
  exec: CommandExecutor,
  host: string,
  container?: string | null,
): Promise<{ certPem: string; keyPem: string; source: string } | null> {
  for (const root of CADDY_DATA_ROOTS) {
    const pair = await findPairIn(exec, root, host, container);
    if (!pair) continue;
    const certPem = await readMaybeInContainer(exec, pair.certPath, container);
    const keyPem = await readMaybeInContainer(exec, pair.keyPath, container);
    if (certPem.trim() && keyPem.trim()) {
      return { certPem, keyPem, source: `caddy store ${pair.certPath}` };
    }
  }
  return null;
}
