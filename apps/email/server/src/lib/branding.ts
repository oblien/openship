/**
 * Branding - filesystem-backed white-label config.
 *
 * The source of truth is `${BRANDING_PATH}/config.json` (plain JSON,
 * read by Zero, written by the openship dashboard over SSH). Assets
 * (logo, favicon) live under `${BRANDING_PATH}/assets/` and are
 * served at `/branding/assets/*` by [main.ts](../main.ts).
 *
 * Why filesystem instead of a SQLite row:
 *   - One trust boundary: the operator who can SSH the VPS owns the
 *     file. No public mutation endpoint => no credential to leak.
 *   - The Zero server doesn't need a write API for branding at all -
 *     the openship dashboard SSHes into the box and writes the file
 *     directly (same pattern as `mail-credentials.service.ts` etc).
 *   - Static path means assets can be deployed alongside (rsync,
 *     ansible, terraform's local-exec, …) without touching the DB.
 *
 * The first call materialises a default config on disk so the file is
 * always present and operators can `cat`/`jq` it. After that we cache
 * in memory and invalidate on `fs.watch` events.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from '../env';

export type Branding = {
  siteTitle: string;
  siteDescription: string;
  loginHeading: string;
  loginSubtext: string;
  loginFooter: string;
  homeHtml: string | null;
};

export const defaultBranding: Branding = {
  siteTitle: 'OpenShip Mail',
  siteDescription: 'Your self-hosted mailbox.',
  loginHeading: 'OpenShip Mail',
  loginSubtext: 'Sign in with your mailbox credentials',
  loginFooter: 'Self-hosted on your own mail server. No third parties.',
  homeHtml: null,
};

const CONFIG_FILE = 'config.json';
const ASSETS_DIR = 'assets';

let cached: Branding | null = null;
let watcherInstalled = false;

function configPath(): string {
  return join(env.BRANDING_PATH, CONFIG_FILE);
}

export function assetsDir(): string {
  return join(env.BRANDING_PATH, ASSETS_DIR);
}

function ensureSeeded(): void {
  const cfg = configPath();
  if (existsSync(cfg)) return;
  mkdirSync(dirname(cfg), { recursive: true });
  mkdirSync(assetsDir(), { recursive: true });
  writeFileSync(cfg, JSON.stringify(defaultBranding, null, 2) + '\n', { mode: 0o644 });
  console.log(`[branding] seeded default config at ${cfg}`);
}

function readFromDisk(): Branding {
  ensureSeeded();
  const raw = readFileSync(configPath(), 'utf8');
  const parsed = JSON.parse(raw) as Partial<Branding>;
  // Merge over defaults so missing keys don't blow up the UI when an
  // operator hand-edits the file and forgets a field.
  return { ...defaultBranding, ...parsed };
}

function installWatcher(): void {
  if (watcherInstalled) return;
  watcherInstalled = true;
  try {
    watch(configPath(), { persistent: false }, () => {
      cached = null;
    });
  } catch (err) {
    // Watch can fail in containers / non-inotify filesystems. Not
    // fatal - we just lose the auto-reload nicety; reads still hit
    // disk on every cache miss.
    console.warn('[branding] fs.watch unavailable:', err);
  }
}

export function getBranding(): Branding {
  if (cached) return cached;
  cached = readFromDisk();
  installWatcher();
  return cached;
}

export function updateBranding(patch: Partial<Branding>): Branding {
  const current = getBranding();
  const next: Branding = { ...current, ...patch };
  ensureSeeded();
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  cached = next;
  return next;
}
