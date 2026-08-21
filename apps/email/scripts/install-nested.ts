#!/usr/bin/env bun
/**
 * Install Zero's nested server + client packages.
 *
 * They are not root workspace members (`apps/*` matches `apps/email` only),
 * so they keep their own lockfiles. The client depends on the sibling
 * `@zero/server` package; Bun's `file:` protocol copies that tree and hits
 * EPERM on Windows (oven-sh/bun#17006). We depend via `link:` and, if Bun
 * still fails, create a directory junction / symlink ourselves.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EMAIL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = join(EMAIL_ROOT, 'server');
const CLIENT_DIR = join(EMAIL_ROOT, 'client');
const ZERO_SERVER_DEST = join(CLIENT_DIR, 'node_modules', '@zero', 'server');

const target = process.argv[2] ?? 'all';

function bunInstall(cwd: string): number {
  const result = spawnSync('bun', ['install'], {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  return result.status ?? 1;
}

function removeDest(dest: string): void {
  if (!existsSync(dest)) return;
  const st = lstatSync(dest);
  // Junctions/symlinks must be unlinked, not recursively removed — recursive
  // rm can follow the link and delete apps/email/server itself on Windows.
  if (st.isSymbolicLink()) {
    unlinkSync(dest);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
}

function linkZeroServer(): void {
  mkdirSync(join(CLIENT_DIR, 'node_modules', '@zero'), { recursive: true });
  removeDest(ZERO_SERVER_DEST);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(SERVER_DIR, ZERO_SERVER_DEST, type);
  console.log(`Linked @zero/server -> ${SERVER_DIR} (${type})`);
}

function isZeroServerLinked(): boolean {
  return existsSync(join(ZERO_SERVER_DEST, 'package.json'));
}

function clientLooksInstalled(): boolean {
  return existsSync(join(CLIENT_DIR, 'node_modules', 'react', 'package.json'));
}

function installServer(): void {
  const status = bunInstall(SERVER_DIR);
  if (status !== 0) process.exit(status);
}

function installClient(): void {
  const status = bunInstall(CLIENT_DIR);
  if (status === 0) {
    if (!isZeroServerLinked()) linkZeroServer();
    return;
  }
  // Bun 1.3 on Windows cannot copy/symlink `file:`/`link:` deps
  // (oven-sh/bun#17006). If the rest of the tree landed, recover by
  // creating a directory junction (no admin / Developer Mode required).
  if (!clientLooksInstalled()) process.exit(status);
  try {
    linkZeroServer();
  } catch (err) {
    console.error('Failed to link @zero/server after bun install error:', err);
    process.exit(status);
  }
  if (!isZeroServerLinked()) {
    console.error('bun install failed and @zero/server could not be linked');
    process.exit(status);
  }
  console.warn(
    'bun install could not link @zero/server; created a local junction/symlink instead.',
  );
}

if (target === 'server') {
  installServer();
} else if (target === 'client') {
  installClient();
} else {
  installServer();
  installClient();
}
