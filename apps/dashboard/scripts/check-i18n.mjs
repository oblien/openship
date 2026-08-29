// i18n locale-parity checker. English (`locales/en`) is the source of truth;
// every other locale must define the same key at every path. Missing keys fall
// back to English at runtime (see i18n/index.ts deepMerge), so drift is silent —
// this surfaces it.
//
//   bun run i18n:check          → summary (counts per namespace), exit 1 on drift
//   bun run i18n:check --full   → also list every missing/extra key
//
// Reused by the parity test (src/i18n/i18n-parity.test.ts) so the CLI and the
// test can never disagree about what "drift" means.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_LOCALE = "en";

/** Absolute path to the locales dir, resolved relative to this script. */
export function defaultLocalesDir() {
  return fileURLToPath(new URL("../src/i18n/locales", import.meta.url));
}

/** Flatten a nested dict to dotted leaf paths (arrays are treated as leaves). */
function leafKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const kp = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leafKeys(v, kp));
    else out.push(kp);
  }
  return out;
}

function leafEntries(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const kp = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) leafEntries(v, kp, out);
    else out[kp] = v;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Is this value worth flagging when a locale copies English verbatim?
 *
 * Plenty of strings are LEGITIMATELY identical across languages — "Email", "DNS",
 * "GitHub", "OK", "URL", a `••••••••` placeholder, `you@example.com`. Flagging those
 * would bury the real signal, so this only considers values that read like PROSE:
 * multiple words, and long enough that a shared product noun is unlikely.
 *
 * That is a heuristic, deliberately. It exists to catch the case that key-parity
 * cannot see at all — a key that is PRESENT in every locale while still holding the
 * English sentence, so the UI silently renders English and every test stays green.
 */
function looksTranslatable(value) {
  return typeof value === "string" && value.trim().length > 3 && /\s/.test(value.trim());
}

/**
 * Compare every non-English locale to the English source across all namespaces.
 * @returns {{
 *   missing: {locale:string,namespace:string,key:string}[],
 *   extra: {locale:string,namespace:string,key:string}[],
 *   untranslated: {locale:string,namespace:string,key:string}[],
 *   byNamespaceMissing: Record<string,number>,
 *   byLocaleMissing: Record<string,number>,
 *   byNamespaceUntranslated: Record<string,number>,
 *   totalMissing: number, totalExtra: number, totalUntranslated: number,
 * }}
 */
export function checkI18nParity(localesDir = defaultLocalesDir()) {
  const enDir = path.join(localesDir, SOURCE_LOCALE);
  const namespaces = fs
    .readdirSync(enDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  const locales = fs
    .readdirSync(localesDir)
    .filter((d) => d !== SOURCE_LOCALE && fs.statSync(path.join(localesDir, d)).isDirectory());

  const missing = [];
  const extra = [];
  const untranslated = [];
  const byNamespaceMissing = {};
  const byLocaleMissing = {};
  const byNamespaceUntranslated = {};

  for (const ns of namespaces) {
    const baseEntries = leafEntries(readJson(path.join(enDir, `${ns}.json`)));
    const base = Object.keys(baseEntries);
    const baseSet = new Set(base);
    for (const locale of locales) {
      const file = path.join(localesDir, locale, `${ns}.json`);
      let localeEntries = {};
      if (fs.existsSync(file)) localeEntries = leafEntries(readJson(file));
      const localeKeys = new Set(Object.keys(localeEntries));
      for (const k of base) if (!localeKeys.has(k)) missing.push({ locale, namespace: ns, key: k });
      for (const k of localeKeys) if (!baseSet.has(k)) extra.push({ locale, namespace: ns, key: k });
      // Present, but still the English sentence — invisible to the two checks above.
      for (const k of localeKeys) {
        if (!baseSet.has(k)) continue;
        if (localeEntries[k] === baseEntries[k] && looksTranslatable(baseEntries[k])) {
          untranslated.push({ locale, namespace: ns, key: k });
        }
      }
    }
  }

  for (const m of missing) {
    byNamespaceMissing[m.namespace] = (byNamespaceMissing[m.namespace] ?? 0) + 1;
    byLocaleMissing[m.locale] = (byLocaleMissing[m.locale] ?? 0) + 1;
  }
  for (const u of untranslated) {
    byNamespaceUntranslated[u.namespace] = (byNamespaceUntranslated[u.namespace] ?? 0) + 1;
  }

  return {
    missing,
    extra,
    untranslated,
    byNamespaceMissing,
    byLocaleMissing,
    byNamespaceUntranslated,
    totalMissing: missing.length,
    totalExtra: extra.length,
    totalUntranslated: untranslated.length,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isMain()) {
  const full = process.argv.includes("--full");
  const r = checkI18nParity();

  if (r.totalMissing === 0 && r.totalExtra === 0 && r.totalUntranslated === 0) {
    console.log("✓ i18n parity: every locale matches the English source.");
    process.exit(0);
  }

  console.log(
    `i18n drift vs "${SOURCE_LOCALE}" — missing: ${r.totalMissing}, extra: ${r.totalExtra}, ` +
      `untranslated: ${r.totalUntranslated}\n`,
  );

  const nsRows = Object.entries(r.byNamespaceMissing).sort((a, b) => b[1] - a[1]);
  if (nsRows.length) {
    console.log("Missing keys by namespace (summed across locales):");
    for (const [ns, n] of nsRows) console.log(`  ${ns.padEnd(18)} ${n}`);
    console.log("");
  }
  const locRows = Object.entries(r.byLocaleMissing).sort((a, b) => b[1] - a[1]);
  if (locRows.length) {
    console.log("Missing keys by locale:");
    for (const [l, n] of locRows) console.log(`  ${l.padEnd(6)} ${n}`);
    console.log("");
  }
  // Present in every locale, still the English sentence — the case key parity cannot
  // see, and the one that renders English in the UI while looking complete.
  const untRows = Object.entries(r.byNamespaceUntranslated).sort((a, b) => b[1] - a[1]);
  if (untRows.length) {
    console.log("Untranslated VALUES by namespace (locale string == English):");
    for (const [ns, n] of untRows) console.log(`  ${ns.padEnd(18)} ${n}`);
    console.log("");
  }

  if (full) {
    const group = (items) => {
      const m = new Map();
      for (const it of items) {
        const id = `${it.namespace}.${it.key}`;
        if (!m.has(id)) m.set(id, new Set());
        m.get(id).add(it.locale);
      }
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    };
    if (r.untranslated.length) {
      console.log("UNTRANSLATED (key → locales still showing English):");
      for (const [id, locs] of group(r.untranslated)) {
        console.log(`  ${id}  [${[...locs].sort().join(",")}]`);
      }
      console.log("");
    }
    if (r.missing.length) {
      console.log("MISSING (key → locales that lack it):");
      for (const [id, locs] of group(r.missing)) console.log(`  ${id}  [${[...locs].sort().join(",")}]`);
      console.log("");
    }
    if (r.extra.length) {
      console.log("EXTRA (stale locale keys not in en):");
      for (const [id, locs] of group(r.extra)) console.log(`  ${id}  [${[...locs].sort().join(",")}]`);
      console.log("");
    }
  } else {
    console.log("Run with --full to list every key.");
  }

  process.exit(1);
}
