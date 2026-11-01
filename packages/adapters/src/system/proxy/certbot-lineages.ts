import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { readdir } from "node:fs/promises";
import { posix as path } from "node:path";
import type { CommandExecutor } from "../../types";
import { sq } from "../local-shell";

/** Required scalar fields from Certbot's configobj renewal records. */
export function parseCertbotRenewalConfig(conf: string) {
  const kinds = ["cert", "privkey", "chain", "fullchain"] as const;
  const paths = new Map<string, string>();
  const params = new Map<string, string>();
  let section: Map<string, string> | null = paths;
  let multiline: string | null = null;
  for (const raw of conf.split(/\r?\n/)) {
    if (multiline) {
      if (raw.includes(multiline)) multiline = null;
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]\s*(?:#.*)?$/);
    if (header) {
      section = header[1] === "renewalparams" ? params : null;
      continue;
    }
    const assignment = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!assignment) {
      if (section) return null;
      continue;
    }
    const [, key, value] = assignment as [string, string, string];
    const wanted =
      section === paths
        ? key === "archive_dir" || kinds.some((kind) => kind === key)
        : key === "authenticator" || key === "server";
    if (!section || !wanted) {
      // Certbot owns plugin settings and hook commands, including multiline or
      // triple-quoted values. Do not parse their content as renewal metadata.
      const quote = value.match(/^("""|''')/)?.[1];
      if (quote && !value.slice(3).includes(quote)) multiline = quote;
      continue;
    }
    const scalar = value.match(/^(?:"([^"]*)"|'([^']*)'|(?!["'])([^#]*?))\s*(?:#.*)?$/);
    if (!scalar || section.has(key)) return null;
    section.set(key, (scalar[1] ?? scalar[2] ?? scalar[3] ?? "").trim());
  }
  if (multiline || !params.get("authenticator")) return null;
  const files = {} as Record<(typeof kinds)[number], string>;
  for (const kind of kinds) {
    const file = paths.get(kind);
    if (!file) return null;
    files[kind] = file;
  }
  return { files, archiveDir: paths.get("archive_dir"), server: params.get("server") };
}

/** Additional Certbot lineages for a hostname use numeric suffixes. */
export function isCertbotLineageName(name: string, hostname: string): boolean {
  return (
    name === hostname ||
    (name.startsWith(`${hostname}-`) && /^\d{4,}$/.test(name.slice(hostname.length + 1)))
  );
}

/** Read candidate directories in the certificate store's own execution namespace. */
export async function certbotLineageDirs(
  executor: CommandExecutor | null,
  hostname: string,
  certDir = "/etc/letsencrypt/live",
): Promise<string[]> {
  const names = executor
    ? (await executor.exec(`ls -1 ${sq(certDir)} 2>/dev/null`).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/system/proxy/certbot-lineages"); return ""; })).split("\n")
    : await readdir(certDir).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/system/proxy/certbot-lineages"); return [] as string[]; });
  const dirs = names
    .filter((name) => isCertbotLineageName(name, hostname))
    .sort()
    .reverse()
    .map((name) => path.join(certDir, name));
  return dirs.length ? dirs : [path.join(certDir, hostname)];
}
