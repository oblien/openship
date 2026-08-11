/**
 * Node runtime provisioning for the tarball-distributed CLI. Node is the SHIPPED
 * runtime (Bun is only the build tool) — this ends the Bun-vs-native-addon crash
 * class (ssh2 cpu-features, oven-sh/bun#18546) by never touching the user's
 * global runtime.
 *
 * scripts/install.sh is the FIRST-install provisioner (POSIX sh, no node yet);
 * this module is the Node-side twin used by `openship update` so a release that
 * raises the Node floor self-heals — it re-checks the floor and fetches a fresh
 * Node 22 from nodejs.org (sha256-verified) only when neither the system node
 * nor the vendored one qualifies. The launcher text here is kept
 * character-identical to the one install.sh writes.
 *
 * POSIX only (darwin/linux). Windows provisioning lives in scripts/install.ps1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { downloadToFile } from "./cache";
import { OS_DIR } from "./paths";

/** Node major-version floor: root engines.node >=22, .node-version 22, Next 16. */
export const NODE_MAJOR = 22;
const NODE_DIST = "https://nodejs.org/dist";

const RUNTIME_DIR = join(OS_DIR, "runtime");
const RUNTIME_CURRENT = join(RUNTIME_DIR, "current");
const BIN_DIR = join(OS_DIR, "bin");

/** Absolute path of the stable launcher the service's ExecStart points at. */
export const LAUNCHER_PATH = join(BIN_DIR, "openship");

/**
 * The launcher script. Location-independent (resolves ~/.openship from its own
 * path) so it works for a non-default OPENSHIP_HOME too. MUST stay identical to
 * the copy scripts/install.sh writes — both are regenerated on install/update.
 */
export const LAUNCHER_SH = `#!/bin/sh
# Openship CLI launcher — runs the tarball-installed CLI under Node.
# Managed by scripts/install.sh and \`openship update\`; manual edits are overwritten.
SELF="$0"
while [ -L "$SELF" ]; do
  _t="$(readlink "$SELF")"
  case "$_t" in /*) SELF="$_t" ;; *) SELF="$(dirname "$SELF")/$_t" ;; esac
done
BIN_DIR="$(cd "$(dirname "$SELF")" && pwd)"
HOME_DIR="$(dirname "$BIN_DIR")"
CLI="$HOME_DIR/cli/current/dist/index.js"
VENDORED_NODE="$HOME_DIR/runtime/current/bin/node"
# Prefer a system node >= ${NODE_MAJOR}; fall back to the vendored runtime.
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0]>=${NODE_MAJOR}?0:1)' 2>/dev/null; then
  exec node "$CLI" "$@"
elif [ -x "$VENDORED_NODE" ]; then
  exec "$VENDORED_NODE" "$CLI" "$@"
else
  echo "openship: no Node >= ${NODE_MAJOR} found (system or vendored). Reinstall: curl -fsSL https://get.openship.io | sh" >&2
  exit 127
fi
`;

export interface NodeRuntime {
  /** `node` (system, on PATH) or an absolute path to the vendored binary. */
  node: string;
  source: "system" | "vendored";
}

function nodeDistOs(): string {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported platform for vendored Node: ${process.platform}`);
}
function nodeDistArch(): string {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Unsupported arch for vendored Node: ${process.arch}`);
}

/** Major version of the `node` at `bin` (or on PATH when bin==="node"), or null. */
function majorOf(bin: string): number | null {
  try {
    const out = execFileSync(bin, ["-e", "process.stdout.write(process.versions.node)"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = Number(out.trim().split(".")[0]);
    return Number.isInteger(m) ? m : null;
  } catch {
    return null;
  }
}

/** Write ~/.openship/bin/openship (the stable launcher) and mark it executable. */
export function writeLauncher(): string {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(LAUNCHER_PATH, LAUNCHER_SH);
  chmodSync(LAUNCHER_PATH, 0o755);
  return LAUNCHER_PATH;
}

function repoint(link: string, target: string): void {
  try {
    if (lstatSync(link)) rmSync(link, { recursive: true, force: true });
  } catch {
    /* no existing link */
  }
  symlinkSync(target, link);
}

/** Newest v22 release on nodejs.org, preferring the LTS line. Returns "v22.x.y". */
async function resolveLatestNode(): Promise<string> {
  const res = await fetch(`${NODE_DIST}/index.json`, {
    headers: { "User-Agent": "openship-cli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Node dist index lookup failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ version: string; lts: string | false }>;
  const prefix = `v${NODE_MAJOR}.`;
  const row =
    rows.find((r) => r.version.startsWith(prefix) && r.lts) ??
    rows.find((r) => r.version.startsWith(prefix));
  if (!row) throw new Error(`No Node ${NODE_MAJOR}.x release found on nodejs.org`);
  return row.version;
}

/** Download + verify + unpack Node into runtime/ and repoint runtime/current. */
async function fetchVendoredNode(onLog?: (m: string) => void): Promise<string> {
  const ver = await resolveLatestNode();
  const os = nodeDistOs();
  const arch = nodeDistArch();
  const name = `node-${ver}-${os}-${arch}.tar.gz`;
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const tarball = join(RUNTIME_DIR, name);

  onLog?.(`Fetching Node ${ver} (${os}-${arch}) from nodejs.org…`);
  const { sha256 } = await downloadToFile(`${NODE_DIST}/${ver}/${name}`, tarball);

  const shaRes = await fetch(`${NODE_DIST}/${ver}/SHASUMS256.txt`, {
    headers: { "User-Agent": "openship-cli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!shaRes.ok) {
    rmSync(tarball, { force: true });
    throw new Error(`Node checksum list fetch failed: HTTP ${shaRes.status}`);
  }
  const expected = (await shaRes.text())
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith(` ${name}`) || l.endsWith(`  ${name}`))
    ?.split(/\s+/)[0]
    ?.toLowerCase();
  if (!expected) {
    rmSync(tarball, { force: true });
    throw new Error(`No checksum for ${name} in SHASUMS256.txt`);
  }
  if (expected !== sha256) {
    rmSync(tarball, { force: true });
    throw new Error(`Node download checksum mismatch (expected ${expected}, got ${sha256}).`);
  }

  const unpacked = join(RUNTIME_DIR, `node-${ver}-${os}-${arch}`);
  rmSync(unpacked, { recursive: true, force: true });
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", RUNTIME_DIR], { stdio: "inherit" });
  if (untar.status !== 0) throw new Error("Failed to extract the Node runtime (is `tar` available?).");
  rmSync(tarball, { force: true });

  const nodeBin = join(unpacked, "bin", "node");
  if (!existsSync(nodeBin)) throw new Error(`Node unpacked but ${nodeBin} is missing (unexpected layout).`);
  repoint(RUNTIME_CURRENT, unpacked);
  return nodeBin;
}

/**
 * Guarantee a node satisfying the floor is available to the launcher. System
 * `node >=NODE_MAJOR` wins (the launcher prefers it); otherwise reuse or fetch a
 * vendored Node under runtime/. Mirrors the launcher's own resolution order.
 */
export async function ensureNodeRuntime(onLog?: (m: string) => void): Promise<NodeRuntime> {
  if ((majorOf("node") ?? 0) >= NODE_MAJOR) return { node: "node", source: "system" };

  const existing = join(RUNTIME_CURRENT, "bin", "node");
  if (existsSync(existing) && (majorOf(existing) ?? 0) >= NODE_MAJOR) {
    return { node: existing, source: "vendored" };
  }
  return { node: await fetchVendoredNode(onLog), source: "vendored" };
}
