#!/usr/bin/env node
/**
 * Refresh the vendored Cloudflare edge IP ranges.
 *
 * These ranges are the edge's real-IP TRUST LIST: `set_real_ip_from` lets any address in
 * them rewrite a request's apparent origin. That is exactly why this is a maintainer-time
 * script writing a committed file rather than a fetch at boot — the list belongs in a diff
 * someone reviewed, not in whatever a hostname answered with while the edge was starting.
 *
 * Cloudflare adds ranges a few times a year, additively. Being stale means traffic from a
 * brand-new range keeps today's behaviour (its country reads as the proxy's); it can never
 * mean a spoofed header is accepted, because an untrusted peer's header is ignored outright.
 *
 * Usage:
 *   node scripts/update-cloudflare-ips.mjs
 *
 * Commit the result, and re-run `bun run edge:conf` in packages/adapters afterwards — the
 * baked edge config embeds these ranges.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(repoRoot, "packages", "adapters", "src", "infra", "cloudflare-ips.generated.ts");

const SOURCES = {
  v4: "https://www.cloudflare.com/ips-v4",
  v6: "https://www.cloudflare.com/ips-v6",
};

/** Strict CIDR shapes. A malformed entry must not reach a trust list. */
const V4 = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const V6 = /^[0-9a-fA-F:]+\/\d{1,3}$/;

async function fetchList(url, shape, label) {
  const res = await fetch(url, { headers: { accept: "text/plain" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const lines = (await res.text())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const bad = lines.filter((l) => !shape.test(l));
  if (bad.length) {
    // Refuse rather than filter. If the endpoint ever starts answering with HTML (a
    // captive portal, an error page, a redirect to a docs site), silently keeping the
    // lines that happen to parse would quietly SHRINK the trust list and start
    // misattributing real traffic — with nothing in the diff to explain why.
    throw new Error(
      `${label}: ${bad.length} line(s) are not ${label} CIDRs — refusing to write.\n` +
        `  first offender: ${JSON.stringify(bad[0])}`,
    );
  }
  // A plausible floor. Cloudflare has published ~15 v4 and ~7 v6 ranges for years; a
  // sudden collapse to two means we fetched something that isn't the list.
  if (lines.length < 5) {
    throw new Error(`${label}: only ${lines.length} range(s) returned — refusing to write.`);
  }
  return lines;
}

const [v4, v6] = await Promise.all([
  fetchList(SOURCES.v4, V4, "IPv4"),
  fetchList(SOURCES.v6, V6, "IPv6"),
]);

// Preserve the file's prose: it explains why the list is trusted unconditionally, which
// is the single most important thing a reader of a trust list needs, and regenerating
// must not quietly delete it.
const previous = readFileSync(OUT, "utf8");
const header = previous.slice(0, previous.indexOf("/** IPv4 ranges"));
const today = new Date().toISOString().slice(0, 10);

const list = (name, source, entries) =>
  `/** ${name}, verbatim from ${source}. */\nexport const ${name === "IPv4 ranges" ? "CLOUDFLARE_IPV4" : "CLOUDFLARE_IPV6"} = [\n` +
  entries.map((e) => `  "${e}",`).join("\n") +
  `\n] as const;\n`;

writeFileSync(
  OUT,
  header +
    list("IPv4 ranges", SOURCES.v4, v4) +
    "\n" +
    list("IPv6 ranges", SOURCES.v6, v6) +
    "\n/** When this list was last refreshed from Cloudflare, for staleness reporting. */\n" +
    `export const CLOUDFLARE_IPS_FETCHED_AT = "${today}";\n`,
);

const before = {
  v4: (previous.match(/"(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}"/g) ?? []).length,
  v6: (previous.match(/"[0-9a-fA-F:]+::\/\d{1,3}"/g) ?? []).length,
};
console.log(
  `Wrote ${OUT}\n` +
    `  IPv4: ${before.v4} → ${v4.length}\n` +
    `  IPv6: ${before.v6} → ${v6.length}\n` +
    (v4.length !== before.v4 || v6.length !== before.v6
      ? "  Ranges CHANGED — re-run `bun run edge:conf` in packages/adapters and commit both files.\n"
      : "  No change to the ranges themselves.\n"),
);
