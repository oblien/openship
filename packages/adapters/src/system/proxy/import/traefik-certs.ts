/**
 * Read a cert out of Traefik's ACME storage (`acme.json`).
 *
 * Traefik keeps every cert its resolvers obtained in a single JSON blob, with the
 * PEMs base64-encoded — there are no cert files on disk to point a path at, which
 * is why the label parser can't populate `tls` and why a Traefik box previously
 * ALWAYS re-issued through ACME on migrate. Traefik is also almost always
 * containerized, so the file usually only exists inside the container (or on
 * whatever host path is bind-mounted there).
 *
 * Shape:
 *   { "<resolver>": { "Account": {...},
 *                     "Certificates": [ { "domain": { "main": "a.com", "sans": [...] },
 *                                         "certificate": "<b64 fullchain PEM>",
 *                                         "key": "<b64 key PEM>" } ] } }
 *
 * Key casing varies across Traefik versions (v2 capitalizes `Certificates`, some
 * builds emit `certificates`), so every lookup here is case-tolerant.
 */

import type { CommandExecutor } from "../../../types";
import { sq } from "../detect";
import { isSafeCertPath } from "../cert-material";
import { readMaybeInContainer } from "../../edge-container-executor";
import { tryExec } from "./parse-utils";

/** Fallbacks when the container's config doesn't name a storage path. */
const DEFAULT_ACME_PATHS = ["/acme.json", "/etc/traefik/acme.json", "/data/acme.json", "/letsencrypt/acme.json"];
const TRAEFIK_STATIC_CONFIGS = [
  "/etc/traefik/traefik.yml",
  "/etc/traefik/traefik.yaml",
  "/etc/traefik/traefik.toml",
];

/** Case-insensitive property lookup — Traefik's key casing isn't stable. */
function prop(obj: Record<string, unknown>, name: string): unknown {
  const hit = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit === undefined ? undefined : obj[hit];
}

/**
 * Storage paths this Traefik might use, most-specific first: whatever its own
 * CLI args / env / static config declares, then the well-known defaults.
 *
 * Reading the declaration matters because the common compose setup mounts a named
 * volume at a custom path (`--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json`),
 * and guessing `/acme.json` there finds nothing.
 */
async function candidateStoragePaths(
  exec: CommandExecutor,
  container?: string | null,
): Promise<string[]> {
  const found: string[] = [];
  const collect = (text: string | null) => {
    for (const m of (text ?? "").matchAll(/acme\.storage[=:\s]+["']?(\/[^\s"',}]+)/gi)) {
      if (isSafeCertPath(m[1])) found.push(m[1]);
    }
    // YAML nests it as `storage: /path` under an `acme:` block; grab bare
    // `storage:` lines pointing at a .json too.
    for (const m of (text ?? "").matchAll(/(?:^|\s)storage:\s*["']?(\/[^\s"',}]+\.json)/gi)) {
      if (isSafeCertPath(m[1])) found.push(m[1]);
    }
  };

  if (container) {
    collect(
      await tryExec(
        exec,
        `docker inspect ${sq(container)} --format '{{json .Config.Cmd}} {{json .Args}} {{json .Config.Env}}' 2>/dev/null`,
      ),
    );
    for (const cfg of TRAEFIK_STATIC_CONFIGS) {
      collect(await readMaybeInContainer(exec, cfg, container));
    }
  }
  return [...new Set([...found, ...DEFAULT_ACME_PATHS])];
}

/** Read the first candidate path that yields JSON. */
async function loadAcmeJson(
  exec: CommandExecutor,
  container?: string | null,
): Promise<{ raw: string; path: string } | null> {
  for (const path of await candidateStoragePaths(exec, container)) {
    const raw = await readMaybeInContainer(exec, path, container);
    if (raw.trim().startsWith("{")) return { raw, path };
  }
  return null;
}

interface AcmeCertEntry {
  domain?: { main?: string; sans?: string[] };
  certificate?: string;
  key?: string;
}

/**
 * PURE. Find the cert entry covering `host` in a parsed acme.json and decode it.
 * Matches `domain.main` and every SAN, including a wildcard one label up — a
 * Traefik box serving `a.example.com` off a `*.example.com` cert is normal.
 * Exported for unit tests (the I/O half needs a live docker).
 */
export function certFromAcmeJson(
  raw: string,
  host: string,
): { certPem: string; keyPem: string; resolver: string } | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const target = host.toLowerCase();
  const matches = (name: string | undefined): boolean => {
    const n = (name ?? "").toLowerCase();
    if (!n) return false;
    if (n === target) return true;
    if (!n.startsWith("*.")) return false;
    const suffix = n.slice(1);
    return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes(".");
  };

  for (const [resolver, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    const certs = prop(value as Record<string, unknown>, "certificates");
    if (!Array.isArray(certs)) continue;
    for (const entry of certs as AcmeCertEntry[]) {
      const domain = (entry && prop(entry as Record<string, unknown>, "domain")) as
        | AcmeCertEntry["domain"]
        | undefined;
      const names = [domain?.main, ...(domain?.sans ?? [])];
      if (!names.some(matches)) continue;
      const certB64 = prop(entry as Record<string, unknown>, "certificate");
      const keyB64 = prop(entry as Record<string, unknown>, "key");
      if (typeof certB64 !== "string" || typeof keyB64 !== "string") continue;
      const certPem = Buffer.from(certB64, "base64").toString("utf-8");
      const keyPem = Buffer.from(keyB64, "base64").toString("utf-8");
      // A truncated / non-base64 field decodes to garbage rather than failing —
      // require the PEM armour so we hand the validator real material.
      if (!certPem.includes("-----BEGIN") || !keyPem.includes("-----BEGIN")) continue;
      return { certPem, keyPem, resolver };
    }
  }
  return null;
}

/**
 * The PEM pair Traefik currently serves for `host`, out of its ACME storage.
 * Never throws; null when there's no storage or no matching entry.
 */
export async function traefikAcmeCert(
  exec: CommandExecutor,
  host: string,
  container?: string | null,
): Promise<{ certPem: string; keyPem: string; source: string } | null> {
  const loaded = await loadAcmeJson(exec, container);
  if (!loaded) return null;
  const hit = certFromAcmeJson(loaded.raw, host);
  if (!hit) return null;
  return {
    certPem: hit.certPem,
    keyPem: hit.keyPem,
    source: `traefik ${loaded.path} (resolver ${hit.resolver})`,
  };
}

/**
 * Declared certs from a Traefik FILE provider (`tls.certificates[].certFile`), the
 * one Traefik shape that does put PEMs on disk. Returns every declared pair; the
 * caller validates which (if any) covers the host, since the file provider doesn't
 * bind a cert to a hostname — Traefik picks by SNI at request time.
 */
export async function traefikDeclaredCertPaths(
  exec: CommandExecutor,
  container?: string | null,
): Promise<Array<{ certPath: string; keyPath: string }>> {
  const pairs: Array<{ certPath: string; keyPath: string }> = [];
  for (const cfg of TRAEFIK_STATIC_CONFIGS) {
    const text = await readMaybeInContainer(exec, cfg, container);
    if (!text.trim()) continue;
    const certFiles = [...text.matchAll(/certFile:\s*["']?(\/[^\s"',}]+)/gi)].map((m) => m[1]);
    const keyFiles = [...text.matchAll(/keyFile:\s*["']?(\/[^\s"',}]+)/gi)].map((m) => m[1]);
    for (let i = 0; i < Math.min(certFiles.length, keyFiles.length); i++) {
      if (isSafeCertPath(certFiles[i]) && isSafeCertPath(keyFiles[i])) {
        pairs.push({ certPath: certFiles[i], keyPath: keyFiles[i] });
      }
    }
  }
  return pairs;
}
