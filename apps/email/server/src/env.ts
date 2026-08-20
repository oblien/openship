/**
 * Env loader. Reads from process.env at startup and validates.
 *
 * This file is the only place that should touch process.env directly -
 * everywhere else imports `env` so a missing variable fails fast at
 * boot, not deep inside a request handler.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  MINIMAX_BASE_URLS,
  MINIMAX_MODELS,
  type MiniMaxBaseUrl,
  type MiniMaxModel,
} from './lib/minimax';

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * In-development persistent secrets store. Located at
 * `apps/email/server/.dev-secrets.json` (gitignored). The first `bun dev`
 * generates any missing dev-only values and writes them here so the next
 * run reuses the same ones - sessions survive restarts, you don't lose
 * login state mid-iteration.
 *
 * Production NEVER reads or writes this file: missing required vars throw,
 * full stop.
 */
const DEV_SECRETS_PATH = resolve(process.cwd(), '.dev-secrets.json');

function loadDevSecrets(): Record<string, string> {
  if (IS_PROD || !existsSync(DEV_SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DEV_SECRETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveDevSecret(name: string, value: string): void {
  if (IS_PROD) return;
  const current = loadDevSecrets();
  current[name] = value;
  mkdirSync(dirname(DEV_SECRETS_PATH), { recursive: true });
  writeFileSync(DEV_SECRETS_PATH, JSON.stringify(current, null, 2) + '\n', {
    mode: 0o600,
  });
}

const devSecrets = loadDevSecrets();

function required(name: string): string {
  const v = process.env[name];
  if (v) return v;
  if (IS_PROD) throw new Error(`Missing required env var: ${name}`);
  // Dev fallback: reuse the value from .dev-secrets.json if present,
  // otherwise mint a fresh 32-byte hex string and persist it.
  const existing = devSecrets[name];
  if (existing) return existing;
  const generated = randomBytes(32).toString('hex');
  saveDevSecret(name, generated);
  console.warn(
    `[env] ${name} not set - generated dev value (saved to .dev-secrets.json). DO NOT use this in production.`,
  );
  devSecrets[name] = generated;
  return generated;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  return n;
}

function choice<const Values extends readonly string[]>(
  name: string,
  values: Values,
  fallback: Values[number],
): Values[number] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!values.includes(raw as Values[number])) {
    throw new Error(`Env var ${name} must be one of: ${values.join(', ')}`);
  }
  return raw as Values[number];
}

export interface Env {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;

  COOKIE_DOMAIN: string;
  TRUSTED_ORIGINS: string[];

  SESSION_ENCRYPTION_KEY: string;
  SESSION_COOKIE_NAME: string;
  SESSION_TTL_SECONDS: number;

  DEFAULT_IMAP_HOST: string | undefined;
  DEFAULT_IMAP_PORT: number;
  DEFAULT_SMTP_HOST: string | undefined;
  DEFAULT_SMTP_PORT: number;

  MINIMAX_API_KEY: string | undefined;
  MINIMAX_MODEL: MiniMaxModel;
  MINIMAX_BASE_URL: MiniMaxBaseUrl;

  SQLITE_PATH: string;
  /**
   * Filesystem root for white-label config. The directory contains
   *   config.json   - site/login/footer text
   *   assets/       - optional uploaded logo/favicon
   * The Zero server fully owns this directory: it serves `/branding.json`
   * publicly, and accepts authenticated `POST /admin/branding` writes
   * from openship via the shared `BRANDING_ADMIN_TOKEN`. Branding never
   * crosses host boundaries via SSH - openship calls the Zero server's
   * own HTTP API, so the Zero server can run anywhere reachable from
   * openship.
   */
  BRANDING_PATH: string;
  /**
   * Shared secret authenticating openship's branding writes. Sent in
   * the `X-Branding-Admin-Token` header on `POST /admin/branding`.
   * Generated in dev (persisted via dev-secrets) so `bun dev` works
   * without configuration; required in prod.
   */
  BRANDING_ADMIN_TOKEN: string;
}

export const env: Env = {
  NODE_ENV: (process.env.NODE_ENV as Env['NODE_ENV']) ?? 'development',
  PORT: int('PORT', 3030),

  COOKIE_DOMAIN: optional('COOKIE_DOMAIN', 'localhost'),
  // Defaults include the Zero client (:3000) and the openship dashboard
  // (:3001) - the dashboard writes branding here via tRPC and needs CORS
  // to succeed for the operator-facing admin panel.
  TRUSTED_ORIGINS: optional('TRUSTED_ORIGINS', 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  SESSION_ENCRYPTION_KEY: required('SESSION_ENCRYPTION_KEY'),
  SESSION_COOKIE_NAME: optional('SESSION_COOKIE_NAME', 'zero_session'),
  SESSION_TTL_SECONDS: int('SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),

  DEFAULT_IMAP_HOST: process.env.DEFAULT_IMAP_HOST,
  DEFAULT_IMAP_PORT: int('DEFAULT_IMAP_PORT', 993),
  DEFAULT_SMTP_HOST: process.env.DEFAULT_SMTP_HOST,
  DEFAULT_SMTP_PORT: int('DEFAULT_SMTP_PORT', 587),

  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY?.trim() || undefined,
  MINIMAX_MODEL: choice('MINIMAX_MODEL', MINIMAX_MODELS, MINIMAX_MODELS[0]),
  MINIMAX_BASE_URL: choice('MINIMAX_BASE_URL', MINIMAX_BASE_URLS, MINIMAX_BASE_URLS[0]),

  SQLITE_PATH: optional('SQLITE_PATH', './data/zero.db'),
  BRANDING_PATH: optional('BRANDING_PATH', './data/mail-branding'),
  BRANDING_ADMIN_TOKEN: required('BRANDING_ADMIN_TOKEN'),
};
