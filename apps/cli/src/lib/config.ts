/**
 * Persistent CLI config at ~/.openship/config.json.
 *
 * The file holds named CONTEXTS — each pins an API + dashboard endpoint, the
 * PAT issued against them, and optionally cached capabilities (see caps.ts).
 * A single `current` name selects the active context; every authenticated
 * command reads from it (see ship-client.ts).
 *
 * A legacy flat config ({ token, apiUrl, dashboardUrl }) is migrated to a
 * single "default" context on first read.
 */
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { HttpClient } from "@repo/sdk/client";

import { OS_DIR } from "./paths";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";
import { localConnectionEndpoints, openLocalCliSession } from "./local-connection";

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
  organizationId?: string;
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
  organizationId?: string;
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
    const current = obj.current && Object.hasOwn(contexts, obj.current) ? obj.current : names[0];
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

interface CommandConnection {
  config: CliConfig;
  environment: Readonly<{
    context?: string; apiUrl?: string; token?: string; organizationId?: string;
  }>;
  name?: string;
  connection?: CliContext;
  environmentToken?: boolean;
  localAuth?: { required: boolean };
  localToken?: () => Promise<string | undefined>;
  localSession?: ReturnType<typeof openLocalCliSession>;
  close?: () => Promise<void>;
}
const commandContext = new AsyncLocalStorage<CommandConnection>();

/** Pin endpoints, credentials and capabilities together for an entire invocation.
 * Config mutations still read the latest file; they take effect on the next command.
 * Login may explicitly enter a fresh scope after saving its validated connection.
 */
export function withCommandContext<T>(action: () => T): T {
  const config = readConfig();
  for (const context of Object.values(config.contexts)) {
    if (context.caps) Object.freeze(context.caps);
    Object.freeze(context);
  }
  Object.freeze(config.contexts);
  return commandContext.run({
    config: Object.freeze(config),
    environment: Object.freeze({
      context: process.env.OPENSHIP_CONTEXT,
      apiUrl: process.env.OPENSHIP_API_URL,
      token: process.env.OPENSHIP_TOKEN,
      organizationId: process.env.OPENSHIP_ORGANIZATION_ID,
    }),
  }, action);
}

function connectionConfig(): CliConfig {
  return commandContext.getStore()?.config ?? readConfig();
}

function sameApi(left: string | undefined, right: string | undefined): boolean {
  return new HttpClient({ baseUrl: left ?? LOCAL_API_URL }).apiUrl ===
    new HttpClient({ baseUrl: right ?? LOCAL_API_URL }).apiUrl;
}

/** Select one immutable connection for this invocation; never persist CI credentials. */
export function selectCommandConnection(options: { context?: string; apiUrl?: string; local?: boolean } = {}): CliContext {
  const invocation = commandContext.getStore();
  if (!invocation) throw new Error("Select a connection inside a CLI invocation.");
  if (options.local) return selectLocalConnection(invocation, true);
  // An explicit named context selects its complete endpoint/credential pair.
  // Ambient CI credentials must not retarget it or leak into another context.
  const environment = options.context === undefined ? invocation.environment : {};
  const name = options.context ?? environment.context ?? invocation.config.current;
  if (!Object.hasOwn(invocation.config.contexts, name))
    throw new Error(`Unknown context "${name}". Run openship login --context ${name} first.`);
  const saved = invocation.config.contexts[name];
  // Only an unconfigured connection may discover the installation implicitly.
  // An explicit endpoint/context or any saved/ambient credential never gains
  // the host administrator's authority when its own authentication is missing.
  if (options.context === undefined && environment.context === undefined && options.apiUrl === undefined && environment.apiUrl === undefined &&
      saved.apiUrl === undefined && saved.token === undefined && environment.token === undefined && saved.organizationId === undefined && environment.organizationId === undefined)
    return selectLocalConnection(invocation, false);
  const apiUrl = options.apiUrl ?? environment.apiUrl ?? saved.apiUrl;
  const retargeted = !sameApi(apiUrl, saved.apiUrl);
  invocation.name = name;
  invocation.environmentToken = Boolean(environment.token);
  invocation.connection = Object.freeze({
    ...saved,
    apiUrl,
    token: environment.token ?? (retargeted ? undefined : saved.token),
    organizationId: environment.organizationId ?? (retargeted ? undefined : saved.organizationId),
    caps: retargeted ? undefined : saved.caps,
  });
  return invocation.connection;
}

function selectLocalConnection(invocation: CommandConnection, required: boolean): CliContext {
  invocation.name = "local";
  invocation.environmentToken = false;
  invocation.localAuth = { required };
  invocation.connection = Object.freeze(localConnectionEndpoints());
  return invocation.connection;
}

/** Prepare lazy authentication: offline utilities never need a running API. */
export function enableLocalCommandAuthentication(): void {
  const invocation = commandContext.getStore();
  if (!invocation?.localAuth || !invocation.connection?.apiUrl) return;
  const { apiUrl } = invocation.connection;
  const { required } = invocation.localAuth;
  invocation.localToken = async () => {
    // All SDK clients in this invocation share one exchange, even when their
    // first requests overlap. A failed exchange is never retried implicitly.
    invocation.localSession ??= openLocalCliSession(apiUrl, required).then(session => {
      if (session) {
        invocation.close = session.close;
        invocation.connection = Object.freeze({ ...invocation.connection, token: session.token });
      }
      return session;
    });
    return (await invocation.localSession)?.token;
  };
}

export async function closeCommandConnection(): Promise<void> {
  const invocation = commandContext.getStore();
  // A cancelled SDK request may stop awaiting its credential callback while the
  // exchange finishes. Drain that bounded request before signing its session out.
  await invocation?.localSession?.catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "cli/lib/config"); return null; });
  const close = invocation?.close;
  if (invocation) invocation.close = undefined;
  await close?.();
}

export function writeConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = join(CONFIG_DIR, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, CONFIG_PATH);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/* ---------- Context management ---------- */

/** Name of the active context. */
export function getActiveContext(): string {
  return commandContext.getStore()?.name ?? connectionConfig().current;
}

/** A process environment credential is not revoked by editing the saved config. */
export function usesEnvironmentToken(name = getActiveContext()): boolean {
  const invocation = commandContext.getStore();
  return invocation?.name === name && invocation.environmentToken === true;
}

/** Switch the active context. Throws if it doesn't exist. */
export function setActiveContext(name: string): void {
  const config = readConfig();
  if (!Object.hasOwn(config.contexts, name)) {
    throw new Error(`Unknown context "${name}". Run \`openship login --context ${name}\` first.`);
  }
  config.current = name;
  writeConfig(config);
}

/** Resolve a context by name (defaults to active). Returns {} if absent. */
export function getContext(name?: string): CliContext {
  const invocation = commandContext.getStore();
  const selected = name ?? getActiveContext();
  if (selected === invocation?.name && invocation.connection) return invocation.connection;
  const config = connectionConfig();
  return Object.hasOwn(config.contexts, selected) ? config.contexts[selected] : {};
}

/** Create or replace a context's endpoints/token. Does not change `current`. */
export function addContext(
  name: string,
  opts: { apiUrl?: string; dashboardUrl?: string; token?: string; organizationId?: string },
): void {
  const config = readConfig();
  const prev = Object.hasOwn(config.contexts, name) ? config.contexts[name] : {};
  const retargeted = opts.apiUrl !== undefined && !sameApi(opts.apiUrl, prev.apiUrl);
  if (opts.organizationId !== undefined && !opts.organizationId.trim()) throw new Error("Organization ID cannot be empty.");
  const next: CliContext = {
    ...prev,
    ...(retargeted ? { token: undefined, caps: undefined, organizationId: undefined } : {}),
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.dashboardUrl !== undefined ? { dashboardUrl: opts.dashboardUrl } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.organizationId !== undefined ? { organizationId: opts.organizationId } : {}),
  };
  config.contexts = { ...config.contexts, [name]: next };
  writeConfig(config);
}

/** Shallow-merge a patch into a context (defaults to active). Used by caps. */
export function updateContext(name: string, patch: Partial<CliContext>, expectedApiUrl?: string): void {
  const config = readConfig();
  // A late discovery response must not cache one server's caps on a retargeted
  // context, or recreate a context removed while the request was in flight.
  if (expectedApiUrl !== undefined && (!Object.hasOwn(config.contexts, name) ||
    (config.contexts[name].apiUrl ?? LOCAL_API_URL) !== expectedApiUrl)) return;
  config.contexts = { ...config.contexts, [name]: { ...(Object.hasOwn(config.contexts, name) ? config.contexts[name] : {}), ...patch } };
  writeConfig(config);
}

/** Remove a context. Throws when removing the active or the last one. */
export function removeContext(name: string): void {
  const config = readConfig();
  if (!Object.hasOwn(config.contexts, name)) throw new Error(`Unknown context "${name}".`);
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
    organizationId: ctx.organizationId,
    current: name === config.current,
  }));
}

/* ---------- Backward-compatible active-context helpers ---------- */

export function getToken(name?: string): string | null;
export function getToken(name: string | undefined, options: { deferred: true }): string | (() => Promise<string | undefined>) | null;
export function getToken(name?: string, options?: { deferred: true }): string | (() => Promise<string | undefined>) | null {
  const invocation = commandContext.getStore();
  if (options?.deferred && invocation?.localToken && (name === undefined || name === invocation.name))
    return invocation.localToken;
  return getContext(name).token ?? null;
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
