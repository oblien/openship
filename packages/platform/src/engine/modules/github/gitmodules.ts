/**
 * Same-owner submodule discovery for clone tokens (port of the 0.8.0
 * patch, see oblien/openship#979).
 *
 * An App installation token minted for a clone is narrowed to the parent repo
 * (`repositories: [repo]`). Git hands the parent's URL userinfo to relative
 * submodules (`url = ../other.git`), so a private submodule under the same owner
 * 404s as "Repository not found" unless the token also covers it. These helpers
 * read `.gitmodules` and return the bare repo names that should be added to the
 * mint. Only repos under the SAME owner on the SAME host qualify; other owners,
 * other hosts and unparseable URLs are ignored.
 */

/** Upper bound on extra repos added to one installation token. */
export const MAX_SUBMODULE_REPOS = 25;

/**
 * Parse `.gitmodules` text and return lowercased bare repo names under `owner`
 * (excluding the parent itself), de-duplicated, in file order.
 */
export function parseSameOwnerSubmoduleRepos(
  gitmodules: string,
  owner: string,
  parentRepo: string,
  host = "github.com",
): string[] {
  const ownerLc = owner.toLowerCase();
  const parentLc = parentRepo.toLowerCase().replace(/\.git$/i, "");
  const hostLc = host.toLowerCase();
  const found = new Set<string>();
  for (const raw of gitmodules.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw)) continue;
    const m = /^\s*url\s*=\s*(.+?)\s*$/i.exec(raw);
    if (!m) continue;
    const value = m[1].replace(/^"(.*)"$/, "$1");
    const name = resolveSameOwnerRepo(value, ownerLc, parentLc, hostLc);
    if (name && name !== parentLc) found.add(name);
  }
  return [...found];
}

function sameHost(hostname: string, hostLc: string): boolean {
  const h = hostname.toLowerCase();
  return h === hostLc || (hostLc === "github.com" && h === "www.github.com");
}

function resolveSameOwnerRepo(
  url: string,
  ownerLc: string,
  parentLc: string,
  hostLc: string,
): string | null {
  let href = url.trim();
  if (!href) return null;
  // Relative URLs resolve against the parent's URL, exactly as git does.
  if (href.startsWith("./") || href.startsWith("../")) {
    try {
      href = new URL(href, `https://${hostLc}/${ownerLc}/${parentLc}/`).href;
    } catch {
      return null;
    }
  }
  // scp-like ssh: git@host:owner/repo(.git)
  const scp = /^[^@\s/]+@([^:/\s]+):\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(href);
  if (scp) {
    if (!sameHost(scp[1], hostLc)) return null;
    return scp[2].toLowerCase() === ownerLc ? bareName(scp[3]) : null;
  }
  try {
    const u = new URL(href);
    if (!/^(https?|ssh|git):$/i.test(u.protocol)) return null;
    if (!sameHost(u.hostname, hostLc)) return null;
    const parts = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    if (parts[0].toLowerCase() !== ownerLc) return null;
    return bareName(parts[1]);
  } catch {
    return null;
  }
}

function bareName(repo: string): string | null {
  const name = repo.replace(/\.git$/i, "").toLowerCase();
  // GitHub repo names: letters, digits, '-', '_', '.'
  return /^[a-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== ".." ? name : null;
}

/** GitHub Contents API JSON (`encoding: base64`) or already-raw text. */
export function gitmodulesTextFromContentsBody(body: string): string {
  try {
    const json = JSON.parse(body) as { content?: string; encoding?: string };
    if (typeof json.content === "string" && json.encoding === "base64") {
      return Buffer.from(json.content.replace(/\s/g, ""), "base64").toString("utf8");
    }
  } catch {
    // not JSON: already raw text
  }
  return body;
}

/**
 * Union the parent repo with extra repos for an installation-token mint:
 * trimmed, lowercased-deduplicated (first spelling wins), parent first, capped.
 */
export function installationTokenRepositories(
  repo: string | undefined,
  extraRepositories: readonly string[] | undefined,
  cap = MAX_SUBMODULE_REPOS + 1,
): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [repo, ...(extraRepositories ?? [])]) {
    const name = raw?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= cap) break;
  }
  return out.length ? out : undefined;
}
