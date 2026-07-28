/**
 * Persistent CLI config at ~/.openship/config.json.
 *
 * The file holds named CONTEXTS — each pins an API + dashboard endpoint, the
 * PAT issued against them, and optionally cached capabilities (see caps.ts).
 * A single `current` name selects the active context; every authenticated
 * command reads from it (see api-client.ts).
 *
 * A legacy flat config ({ token, apiUrl, dashboardUrl }) is migrated to a
 * single "default" context on first read.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OS_DIR } from "./paths";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";

/** Cached discovery from GET /api/health/env (see caps.ts). */
export interface ContextCaps {
  selfHosted: boolean;
  deployMode: string;
  authMode: string;
  teamMode: string;
  cloudAuthUrl: string | null;
  cloudApiUrl: string | null;
  /** Epoch ms the caps were fetched, for TTL-based refresh. */
  fetchedAt: number;
}

export interface CliContext {
  apiUrl?: string;
  dashboardUrl?: string;
  token?: string;
  caps?: ContextCaps;
}

export interface CliConfig {
  contexts: Record<string, CliContext>;
  current: string;
}

/** Legacy pre-contexts shape, still read from disk once for migration. */
interface LegacyConfig {
  token?: string;
  apiUrl?: string;
  dashboardUrl?: string;
}

/** Summary row for `listContexts`, safe to print (never exposes the token). */
export interface ContextInfo {
  name: string;
  apiUrl: string;
  dashboardUrl: string;
  hasToken: boolean;
  current: boolean;
}

export const DEFAULT_CONTEXT = "default";

const CONFIG_DIR = OS_DIR;
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function emptyConfig(): CliConfig {
  return { contexts: { [DEFAULT_CONTEXT]: {} }, current: DEFAULT_CONTEXT };
}

/** Coerce whatever is on disk (legacy flat or contexts) into a CliConfig. */
function normalize(raw: unknown): CliConfig {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const obj = raw as Partial<CliConfig> & LegacyConfig;

  if (obj.contexts && typeof obj.contexts === "object") {
    const contexts = obj.contexts as Record<string, CliContext>;
    const names = Object.keys(contexts);
    if (names.length === 0) return emptyConfig();
    const current = obj.current && contexts[obj.current] ? obj.current : names[0];
    return { contexts, current };
  }

  // Legacy flat config → single "default" context.
  const legacy: CliContext = {};
  if (obj.token) legacy.token = obj.token;
  if (obj.apiUrl) legacy.apiUrl = obj.apiUrl;
  if (obj.dashboardUrl) legacy.dashboardUrl = obj.dashboardUrl;
  return { contexts: { [DEFAULT_CONTEXT]: legacy }, current: DEFAULT_CONTEXT };
}

export function readConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return emptyConfig();
  try {
    return normalize(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return emptyConfig();
  }
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies on create — force it on an existing file too so the
  // token is never left world-readable.
  chmodSync(CONFIG_PATH, 0o600);
}

/* ---------- Context management ---------- */

/** Name of the active context. */
export function getActiveContext(): string {
  return readConfig().current;
}

/** Switch the active context. Throws if it doesn't exist. */
export function setActiveContext(name: string): void {
  const config = readConfig();
  if (!config.contexts[name]) {
    throw new Error(`Unknown context "${name}". Run \`openship login --context ${name}\` first.`);
  }
  config.current = name;
  writeConfig(config);
}

/** Resolve a context by name (defaults to active). Returns {} if absent. */
export function getContext(name?: string): CliContext {
  const config = readConfig();
  return config.contexts[name ?? config.current] ?? {};
}

/** Create or replace a context's endpoints/token. Does not change `current`. */
export function addContext(
  name: string,
  opts: { apiUrl?: string; dashboardUrl?: string; token?: string },
): void {
  const config = readConfig();
  const prev = config.contexts[name] ?? {};
  config.contexts[name] = {
    ...prev,
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.dashboardUrl !== undefined ? { dashboardUrl: opts.dashboardUrl } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  };
  writeConfig(config);
}

/** Shallow-merge a patch into a context (defaults to active). Used by caps. */
export function updateContext(name: string, patch: Partial<CliContext>): void {
  const config = readConfig();
  config.contexts[name] = { ...(config.contexts[name] ?? {}), ...patch };
  writeConfig(config);
}

/** Remove a context. Throws when removing the active or the last one. */
export function removeContext(name: string): void {
  const config = readConfig();
  if (!config.contexts[name]) throw new Error(`Unknown context "${name}".`);
  if (name === config.current) {
    throw new Error(`Cannot remove the active context "${name}". Switch first.`);
  }
  delete config.contexts[name];
  writeConfig(config);
}

export function listContexts(): ContextInfo[] {
  const config = readConfig();
  return Object.entries(config.contexts).map(([name, ctx]) => ({
    name,
    apiUrl: ctx.apiUrl ?? LOCAL_API_URL,
    dashboardUrl: ctx.dashboardUrl ?? LOCAL_DASHBOARD_URL,
    hasToken: Boolean(ctx.token),
    current: name === config.current,
  }));
}

/* ---------- Backward-compatible active-context helpers ---------- */

export function getToken(): string | null {
  return getContext().token ?? null;
}

export function setToken(
  token: string,
  endpoints?: { apiUrl?: string; dashboardUrl?: string },
): void {
  updateContext(getActiveContext(), { token, ...endpoints });
}

/** Remove the token from a context (defaults to active). */
export function clearToken(name?: string): void {
  const config = readConfig();
  const target = name ?? config.current;
  const ctx = config.contexts[target];
  if (!ctx) return;
  delete ctx.token;
  writeConfig(config);
}

/** Base API URL of a context (no /api suffix). Falls back to local default. */
export function getApiUrl(name?: string): string {
  return getContext(name).apiUrl ?? LOCAL_API_URL;
}

export function getDashboardUrl(name?: string): string {
  return getContext(name).dashboardUrl ?? LOCAL_DASHBOARD_URL;
}
