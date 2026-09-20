/**
 * Organization-scoped custom GitHub Apps: lifecycle, secret storage and
 * source-specific runtime credential resolution.
 *
 * API-facing reads are sanitized here. The only functions that expose
 * decrypted material are explicitly named `resolve*Credentials` and remain
 * server-internal.
 */

import { randomBytes } from "node:crypto";
import { repos, type GitInstallation, type GitSource } from "@repo/db";
import { ConflictError, NotFoundError, ValidationError, safeErrorMessage } from "@repo/core";
import { encryptSecretField, decryptSecretField } from "../../lib/credential-encryption";
import {
  getInstanceReachability,
  resolveDashboardPublicUrl,
  sharedWebhookUrl,
} from "../../lib/public-url";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { githubAppFetch, type GitHubAppClientCredentials } from "./github.app-client";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_WEB_BASE_URL = "https://github.com";
const SETUP_STATE_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15_000;

export interface GitHubSourceSecrets {
  privateKeyPem: string;
  clientSecret?: string;
  webhookSecret: string;
}

export interface PublicGitHubSource {
  id: string;
  name: string;
  provider: "github";
  appId: number;
  slug: string;
  clientId: string | null;
  appName: string | null;
  avatarUrl: string | null;
  apiBaseUrl: string;
  webBaseUrl: string;
  webhookUrl: string;
  setupUrl: string;
  appUrl: string;
  managementUrl: string;
  isDefault: boolean;
  status: string;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  installations: Array<{
    id: number;
    owner: string;
    ownerType: string;
    avatarUrl: string;
    suspendedAt: Date | null;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitHubSourceConfiguration {
  publicReady: boolean;
  publicUrl: string | null;
  webhookUrl: string;
  setupUrl: string;
}

export interface ManualGitHubSourceInput {
  name: string;
  appId: number;
  clientId?: string;
  clientSecret?: string;
  privateKeyPem: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  isDefault?: boolean;
}

export interface UpdateGitHubSourceInput {
  name?: string;
  appId?: number;
  clientId?: string | null;
  clientSecret?: string;
  privateKeyPem?: string;
  webhookSecret?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
}

interface GitHubAppIdentity {
  id: number;
  slug: string;
  name?: string;
  client_id?: string;
  html_url?: string;
  owner?: { avatar_url?: string };
}

interface ManifestConversion extends GitHubAppIdentity {
  client_secret?: string;
  pem?: string;
  webhook_secret?: string;
}

export function normalizeGitHubBaseUrl(
  raw: string | undefined,
  fallback: string,
  label: string,
): string {
  const value = raw?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${label} must be a valid absolute URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ValidationError(`${label} must use HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ValidationError(`${label} cannot contain credentials, a query, or a fragment.`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeName(name: string): string {
  const value = name.trim();
  if (!value) throw new ValidationError("A source name is required.");
  if (value.length > 100) throw new ValidationError("Source names cannot exceed 100 characters.");
  return value;
}

function normalizeAppId(appId: number): number {
  if (!Number.isSafeInteger(appId) || appId <= 0 || appId > 2_147_483_647) {
    throw new ValidationError("GitHub App ID must be a positive integer.");
  }
  return appId;
}

function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError("A GitHub App private key is required.");
  // Accept the common single-line env/file representation as well as a pasted
  // multiline PEM; crypto.createPrivateKey performs the authoritative parse.
  return trimmed.includes("\\n") && !trimmed.includes("\n")
    ? trimmed.replace(/\\n/g, "\n")
    : trimmed;
}

function writeSecrets(secrets: GitHubSourceSecrets): string {
  const sealed = encryptSecretField(JSON.stringify(secrets));
  if (!sealed) throw new Error("Could not encrypt GitHub App credentials.");
  return sealed;
}

export function readGitHubSourceSecrets(source: GitSource): GitHubSourceSecrets {
  let parsed: unknown;
  try {
    const plain = decryptSecretField(source.secretsEnc);
    parsed = plain ? JSON.parse(plain) : null;
  } catch {
    throw new Error(`Credentials for GitHub source "${source.name}" cannot be decrypted.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Credentials for GitHub source "${source.name}" are missing.`);
  }
  const candidate = parsed as Partial<GitHubSourceSecrets>;
  if (
    typeof candidate.privateKeyPem !== "string" ||
    !candidate.privateKeyPem.trim() ||
    typeof candidate.webhookSecret !== "string" ||
    !candidate.webhookSecret
  ) {
    throw new Error(`Credentials for GitHub source "${source.name}" are incomplete.`);
  }
  return {
    privateKeyPem: candidate.privateKeyPem,
    webhookSecret: candidate.webhookSecret,
    ...(typeof candidate.clientSecret === "string" && candidate.clientSecret
      ? { clientSecret: candidate.clientSecret }
      : {}),
  };
}

export function sourceClientCredentials(
  source: GitSource,
  secrets = readGitHubSourceSecrets(source),
): GitHubAppClientCredentials {
  return {
    appId: source.appId,
    privateKeyPem: secrets.privateKeyPem,
    apiBaseUrl: source.apiBaseUrl,
  };
}

export function githubSourceSetupUrl(): string {
  return `${resolveDashboardPublicUrl().replace(/\/+$/, "")}/auth/callback/github-app`;
}

export async function getGitHubSourceConfiguration(): Promise<GitHubSourceConfiguration> {
  // This refreshes the DB-derived self-app URL before the URL builders read it.
  const reachability = await getInstanceReachability();
  return {
    publicReady: reachability.configured,
    publicUrl: reachability.url,
    webhookUrl: sharedWebhookUrl(),
    setupUrl: githubSourceSetupUrl(),
  };
}

async function assertPublicGitHubCallback(): Promise<void> {
  if ((await getGitHubSourceConfiguration()).publicReady) return;
  throw new ValidationError(
    "Configure a public HTTPS URL for this Openship instance before creating a GitHub App. GitHub must be able to reach its setup callback and webhook.",
  );
}

function avatarForInstallation(installation: GitInstallation, webBaseUrl: string): string {
  const id = Number(installation.providerOwnerId);
  return webBaseUrl === DEFAULT_WEB_BASE_URL && Number.isSafeInteger(id) && id > 0
    ? `https://avatars.githubusercontent.com/u/${id}?v=4`
    : `${webBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(installation.owner)}.png`;
}

function sanitizeSource(source: GitSource, installations: GitInstallation[]): PublicGitHubSource {
  const web = source.webBaseUrl.replace(/\/+$/, "");
  return {
    id: source.id,
    name: source.name,
    provider: "github",
    appId: source.appId,
    slug: source.slug,
    clientId: source.clientId,
    appName: source.appName,
    avatarUrl: source.avatarUrl,
    apiBaseUrl: source.apiBaseUrl,
    webBaseUrl: source.webBaseUrl,
    webhookUrl: source.webhookUrl,
    setupUrl: githubSourceSetupUrl(),
    appUrl: `${web}/apps/${encodeURIComponent(source.slug)}`,
    managementUrl: `${web}/settings/apps/${encodeURIComponent(source.slug)}`,
    isDefault: source.isDefault,
    status: source.status,
    lastVerifiedAt: source.lastVerifiedAt,
    lastError: source.lastError,
    installations: installations
      .filter((installation) => installation.sourceId === source.id)
      .map((installation) => ({
        id: installation.installationId,
        owner: installation.owner,
        ownerType: installation.ownerType,
        avatarUrl: avatarForInstallation(installation, source.webBaseUrl),
        suspendedAt: installation.suspendedAt,
      })),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export async function listGitHubSources(organizationId: string): Promise<PublicGitHubSource[]> {
  const [sources, installations] = await Promise.all([
    repos.gitSource.listByOrganization(organizationId),
    repos.gitInstallation.listAllByOrganization(organizationId),
  ]);
  return sources.map((source) => sanitizeSource(source, installations));
}

export async function hasActiveGitHubSource(organizationId: string): Promise<boolean> {
  return (await repos.gitSource.listActiveByOrganization(organizationId)).length > 0;
}

/** Whether this workspace owns any GitHub App source, including one that needs
 * attention. The Settings connection card uses this management fact to avoid
 * presenting the legacy Openship App controls for a custom App. Runtime token
 * resolution must continue to use `hasActiveGitHubSource` instead. */
export async function hasConfiguredGitHubSource(organizationId: string): Promise<boolean> {
  return (await repos.gitSource.listByOrganization(organizationId)).length > 0;
}

async function verifyIdentity(
  credentials: GitHubAppClientCredentials,
  expectedAppId: number,
): Promise<GitHubAppIdentity> {
  const app = await githubAppFetch<GitHubAppIdentity>(credentials, "/app");
  if (!Number.isSafeInteger(app.id) || app.id !== expectedAppId || !app.slug) {
    throw new ValidationError("The private key does not belong to the supplied GitHub App ID.");
  }
  return app;
}

async function assertSourceUnique(
  organizationId: string,
  input: { name: string; appId: number; apiBaseUrl: string },
  exceptId?: string,
): Promise<void> {
  if (await repos.gitSource.nameTaken(organizationId, input.name, exceptId)) {
    throw new ConflictError(`A GitHub source named "${input.name}" already exists.`);
  }
  if (await repos.gitSource.appTaken(organizationId, input.apiBaseUrl, input.appId, exceptId)) {
    throw new ConflictError("This GitHub App is already connected to the workspace.");
  }
}

export async function createManualGitHubSource(
  organizationId: string,
  input: ManualGitHubSourceInput,
): Promise<PublicGitHubSource> {
  await assertPublicGitHubCallback();
  const name = normalizeName(input.name);
  const appId = normalizeAppId(input.appId);
  const apiBaseUrl = normalizeGitHubBaseUrl(
    input.apiBaseUrl,
    DEFAULT_API_BASE_URL,
    "GitHub API URL",
  );
  const webBaseUrl = normalizeGitHubBaseUrl(
    input.webBaseUrl,
    DEFAULT_WEB_BASE_URL,
    "GitHub web URL",
  );
  const privateKeyPem = normalizePrivateKey(input.privateKeyPem);
  const webhookSecret = input.webhookSecret.trim();
  if (webhookSecret.length < 16) {
    throw new ValidationError("The webhook secret must contain at least 16 characters.");
  }
  await assertSourceUnique(organizationId, { name, appId, apiBaseUrl });

  const secrets: GitHubSourceSecrets = {
    privateKeyPem,
    webhookSecret,
    ...(input.clientSecret?.trim() ? { clientSecret: input.clientSecret.trim() } : {}),
  };
  let identity: GitHubAppIdentity;
  try {
    identity = await verifyIdentity({ appId, privateKeyPem, apiBaseUrl }, appId);
  } catch (error) {
    throw new ValidationError(redactedVerifyError(error));
  }
  const source = await repos.gitSource.create({
    organizationId,
    name,
    appId,
    slug: identity.slug,
    clientId: input.clientId?.trim() || identity.client_id || null,
    appName: identity.name?.trim() || null,
    avatarUrl: identity.owner?.avatar_url ?? null,
    apiBaseUrl,
    webBaseUrl,
    webhookUrl: sharedWebhookUrl(),
    secretsEnc: writeSecrets(secrets),
    isDefault: input.isDefault ?? false,
    status: "active",
    lastVerifiedAt: new Date(),
    lastError: null,
  });
  return sanitizeSource(source, []);
}

function manifestAppName(sourceName: string): string {
  let host = "self-hosted";
  try {
    host = new URL(resolveDashboardPublicUrl()).hostname.replace(/[^a-z0-9-]/gi, "-");
  } catch {
    // Keep the stable fallback; URL validation happens elsewhere at startup.
  }
  const suffix = randomBytes(3).toString("hex");
  const stem = `OpenShip ${sourceName} ${host}`.replace(/\s+/g, " ").trim();
  return `${stem.slice(0, Math.max(1, 33 - suffix.length)).trim()}-${suffix}`;
}

export async function beginGitHubManifestFlow(
  ctx: RequestContext,
  input: { name: string },
): Promise<{ url: string; manifest: Record<string, unknown> }> {
  await assertPublicGitHubCallback();
  const name = normalizeName(input.name);
  if (await repos.gitSource.nameTaken(ctx.organizationId, name)) {
    throw new ConflictError(`A GitHub source named "${name}" already exists.`);
  }
  const state = randomBytes(24).toString("base64url");
  await repos.githubInstallState.purgeExpired().catch(() => 0);
  await repos.githubInstallState.create({
    state,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    flow: "manifest",
    payload: {
      name,
      apiBaseUrl: DEFAULT_API_BASE_URL,
      webBaseUrl: DEFAULT_WEB_BASE_URL,
    },
    expiresAt: new Date(Date.now() + SETUP_STATE_TTL_MS),
  });

  const callback = `${githubSourceSetupUrl()}?flow=manifest&state=${encodeURIComponent(state)}`;
  return {
    url: "https://github.com/settings/apps/new",
    manifest: {
      name: manifestAppName(name),
      url: resolveDashboardPublicUrl(),
      redirect_url: callback,
      setup_url: githubSourceSetupUrl(),
      setup_on_update: false,
      public: false,
      request_oauth_on_install: false,
      hook_attributes: {
        url: sharedWebhookUrl(),
        active: true,
      },
      default_permissions: {
        checks: "write",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
        statuses: "write",
      },
      default_events: ["check_run", "pull_request", "push"],
    },
  };
}

async function exchangeManifestCode(apiBaseUrl: string, code: string): Promise<ManifestConversion> {
  const response = await fetch(
    `${apiBaseUrl.replace(/\/+$/, "")}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );
  const raw = await response.text();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message.slice(0, 300)
        : "conversion failed";
    throw new ValidationError(
      `GitHub App manifest conversion failed (${response.status}): ${message}`,
    );
  }
  return data as ManifestConversion;
}

export async function convertGitHubManifest(
  ctx: RequestContext,
  input: { state: string; code: string },
): Promise<{ source: PublicGitHubSource; installUrl: string }> {
  const binding = await repos.githubInstallState.find(input.state).catch(() => null);
  if (
    !binding ||
    binding.flow !== "manifest" ||
    binding.userId !== ctx.userId ||
    binding.organizationId !== ctx.organizationId
  ) {
    throw new ValidationError(
      "This GitHub App creation link is expired, already used, or belongs to another workspace.",
    );
  }
  const name = normalizeName(binding.payload?.name ?? "GitHub App");
  const apiBaseUrl = normalizeGitHubBaseUrl(
    binding.payload?.apiBaseUrl,
    DEFAULT_API_BASE_URL,
    "GitHub API URL",
  );
  const webBaseUrl = normalizeGitHubBaseUrl(
    binding.payload?.webBaseUrl,
    DEFAULT_WEB_BASE_URL,
    "GitHub web URL",
  );
  const converted = await exchangeManifestCode(apiBaseUrl, input.code);
  if (
    !Number.isSafeInteger(converted.id) ||
    converted.id <= 0 ||
    !converted.slug ||
    !converted.pem ||
    !converted.webhook_secret
  ) {
    throw new ValidationError("GitHub returned an incomplete App manifest conversion.");
  }
  await assertSourceUnique(ctx.organizationId, {
    name,
    appId: converted.id,
    apiBaseUrl,
  });
  // The conversion response is authenticated GitHub data and contains the only
  // copy of the generated private key. Persist it immediately; an extra /app
  // probe here would orphan the newly-created App if the network failed after
  // GitHub consumed the one-shot conversion code.
  const identity = converted;
  const source = await repos.gitSource.createFromManifestState(
    input.state,
    ctx.userId,
    ctx.organizationId,
    {
      organizationId: ctx.organizationId,
      name,
      appId: converted.id,
      slug: identity.slug,
      clientId: converted.client_id ?? identity.client_id ?? null,
      appName: identity.name?.trim() || null,
      avatarUrl: identity.owner?.avatar_url ?? null,
      apiBaseUrl,
      webBaseUrl,
      webhookUrl: sharedWebhookUrl(),
      secretsEnc: writeSecrets({
        privateKeyPem: converted.pem,
        webhookSecret: converted.webhook_secret,
        ...(converted.client_secret ? { clientSecret: converted.client_secret } : {}),
      }),
      status: "active",
      lastVerifiedAt: new Date(),
      lastError: null,
    },
  );
  if (!source) {
    throw new ConflictError("This GitHub App creation link was already used.");
  }
  const install = await createSourceInstallUrl(ctx, source.id);
  const { invalidateOrgGitHubCache } = await import("./github.auth");
  await invalidateOrgGitHubCache(ctx.organizationId);
  return { source: sanitizeSource(source, []), installUrl: install.url };
}

export async function updateGitHubSource(
  organizationId: string,
  id: string,
  input: UpdateGitHubSourceInput,
): Promise<PublicGitHubSource> {
  const current = await repos.gitSource.findById(organizationId, id);
  if (!current) throw new NotFoundError("GitHub source", id);
  const existingSecrets = readGitHubSourceSecrets(current);
  const name = input.name === undefined ? current.name : normalizeName(input.name);
  const appId = normalizeAppId(input.appId ?? current.appId);
  const apiBaseUrl =
    input.apiBaseUrl === undefined
      ? current.apiBaseUrl
      : normalizeGitHubBaseUrl(input.apiBaseUrl, DEFAULT_API_BASE_URL, "GitHub API URL");
  const webBaseUrl =
    input.webBaseUrl === undefined
      ? current.webBaseUrl
      : normalizeGitHubBaseUrl(input.webBaseUrl, DEFAULT_WEB_BASE_URL, "GitHub web URL");
  await assertSourceUnique(organizationId, { name, appId, apiBaseUrl }, id);

  const installations = await repos.gitInstallation.listAllByOrganization(organizationId);
  const used = installations.some((installation) => installation.sourceId === id);
  if (used && (appId !== current.appId || apiBaseUrl !== current.apiBaseUrl)) {
    throw new ConflictError(
      "Remove this source's GitHub installations before changing its App ID or API URL.",
    );
  }

  const secrets: GitHubSourceSecrets = {
    privateKeyPem:
      input.privateKeyPem === undefined
        ? existingSecrets.privateKeyPem
        : normalizePrivateKey(input.privateKeyPem),
    webhookSecret: input.webhookSecret?.trim() || existingSecrets.webhookSecret,
    ...(input.clientSecret?.trim()
      ? { clientSecret: input.clientSecret.trim() }
      : existingSecrets.clientSecret
        ? { clientSecret: existingSecrets.clientSecret }
        : {}),
  };
  if (secrets.webhookSecret.length < 16) {
    throw new ValidationError("The webhook secret must contain at least 16 characters.");
  }
  let identity: GitHubAppIdentity;
  try {
    identity = await verifyIdentity(
      { appId, privateKeyPem: secrets.privateKeyPem, apiBaseUrl },
      appId,
    );
  } catch (error) {
    throw new ValidationError(redactedVerifyError(error));
  }
  const updated = await repos.gitSource.update(organizationId, id, {
    name,
    appId,
    slug: identity.slug,
    clientId:
      input.clientId === undefined
        ? (current.clientId ?? identity.client_id ?? null)
        : input.clientId?.trim() || null,
    appName: identity.name?.trim() || current.appName,
    avatarUrl: identity.owner?.avatar_url ?? current.avatarUrl,
    apiBaseUrl,
    webBaseUrl,
    webhookUrl: sharedWebhookUrl(),
    secretsEnc: writeSecrets(secrets),
    status: "active",
    lastVerifiedAt: new Date(),
    lastError: null,
  });
  if (!updated) throw new NotFoundError("GitHub source", id);
  const { invalidateOrgGitHubCache } = await import("./github.auth");
  await invalidateOrgGitHubCache(organizationId);
  return sanitizeSource(updated, installations);
}

function redactedVerifyError(error: unknown): string {
  const message = safeErrorMessage(error);
  const status = message.match(/\((\d{3})\)/)?.[1];
  return status
    ? `GitHub rejected the App credentials (HTTP ${status}).`
    : "GitHub App verification failed. Check the App ID, private key, and API URL.";
}

export async function verifyGitHubSource(
  organizationId: string,
  id: string,
): Promise<PublicGitHubSource> {
  const source = await repos.gitSource.findById(organizationId, id);
  if (!source) throw new NotFoundError("GitHub source", id);
  try {
    const identity = await verifyIdentity(sourceClientCredentials(source), source.appId);
    const updated = await repos.gitSource.update(organizationId, id, {
      slug: identity.slug,
      clientId: source.clientId ?? identity.client_id ?? null,
      appName: identity.name?.trim() || source.appName,
      avatarUrl: identity.owner?.avatar_url ?? source.avatarUrl,
      status: "active",
      lastVerifiedAt: new Date(),
      lastError: null,
    });
    if (!updated) throw new NotFoundError("GitHub source", id);
    const installations = await repos.gitInstallation.listAllByOrganization(organizationId);
    return sanitizeSource(updated, installations);
  } catch (error) {
    const reason = redactedVerifyError(error);
    await repos.gitSource.markInvalid(organizationId, id, reason);
    throw new ValidationError(reason);
  }
}

export async function setDefaultGitHubSource(
  organizationId: string,
  id: string,
): Promise<PublicGitHubSource> {
  const source = await repos.gitSource.findActiveById(organizationId, id);
  if (!source) throw new NotFoundError("Active GitHub source", id);
  const updated = await repos.gitSource.setDefault(organizationId, id);
  if (!updated) throw new NotFoundError("GitHub source", id);
  const { invalidateOrgGitHubCache } = await import("./github.auth");
  await invalidateOrgGitHubCache(organizationId);
  const installations = await repos.gitInstallation.listAllByOrganization(organizationId);
  return sanitizeSource(updated, installations);
}

export async function deleteGitHubSource(organizationId: string, id: string): Promise<GitSource> {
  const removed = await repos.gitInstallation.removeSourceAndRebind(organizationId, id);
  if (!removed) throw new NotFoundError("GitHub source", id);
  const { invalidateOrgGitHubCache } = await import("./github.auth");
  await invalidateOrgGitHubCache(organizationId);
  return removed;
}

export async function createSourceInstallUrl(
  ctx: RequestContext,
  sourceId: string,
): Promise<{ url: string; state: string }> {
  const source = await repos.gitSource.findActiveById(ctx.organizationId, sourceId);
  if (!source) throw new NotFoundError("Active GitHub source", sourceId);
  const state = randomBytes(24).toString("base64url");
  await repos.githubInstallState.purgeExpired().catch(() => 0);
  await repos.githubInstallState.create({
    state,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    sourceId: source.id,
    flow: "install",
    expiresAt: new Date(Date.now() + SETUP_STATE_TTL_MS),
  });
  return {
    url: `${source.webBaseUrl.replace(/\/+$/, "")}/apps/${encodeURIComponent(source.slug)}/installations/new?state=${encodeURIComponent(state)}`,
    state,
  };
}

export async function resolveGitHubSourceCredentialsForInstallation(
  organizationId: string,
  owner: string,
  installationId?: number,
): Promise<{
  installation: GitInstallation;
  source: GitSource;
  secrets: GitHubSourceSecrets;
  credentials: GitHubAppClientCredentials;
} | null> {
  const installation = installationId
    ? await repos.gitInstallation.findByOrgOwnerAndInstallationId(
        organizationId,
        owner,
        installationId,
      )
    : await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  if (!installation?.sourceId) return null;
  const source = await repos.gitSource.findActiveById(organizationId, installation.sourceId);
  if (!source) return null;
  const secrets = readGitHubSourceSecrets(source);
  return {
    installation,
    source,
    secrets,
    credentials: sourceClientCredentials(source, secrets),
  };
}

export async function resolveGitHubApiBaseUrl(
  organizationId: string,
  owner: string,
  installationId?: number,
): Promise<string | null> {
  const resolved = await resolveGitHubSourceCredentialsForInstallation(
    organizationId,
    owner,
    installationId,
  );
  return resolved?.source.apiBaseUrl ?? null;
}

export async function resolveGitHubWebBaseUrl(
  organizationId: string,
  owner: string,
  installationId?: number,
): Promise<string | null> {
  const resolved = await resolveGitHubSourceCredentialsForInstallation(
    organizationId,
    owner,
    installationId,
  );
  return resolved?.source.webBaseUrl ?? null;
}

/**
 * Resolve only sources that could have emitted a webhook. Installation rows
 * are the strongest discriminator; App ID covers the pre-claim
 * installation.created delivery; all-active is reserved for GitHub's ping
 * payload, which carries neither on some Enterprise versions.
 */
export async function listGitHubSourcesForWebhook(input: {
  installationId?: number;
  appId?: number;
  allowAllFallback?: boolean;
}): Promise<GitSource[]> {
  if (input.installationId) {
    const installations = await repos.gitInstallation
      .findByInstallationIdForProvider(input.installationId)
      .catch(() => []);
    const sources = await Promise.all(
      installations
        .filter((installation) => installation.sourceId)
        .map((installation) =>
          repos.gitSource.findActiveById(installation.organizationId, installation.sourceId!),
        ),
    );
    const unique = new Map<string, GitSource>();
    for (const source of sources) {
      if (source) unique.set(source.id, source);
    }
    if (unique.size > 0) return [...unique.values()];
  }
  if (input.appId) {
    const sources = await repos.gitSource.listActiveByAppId(input.appId);
    if (sources.length > 0) return sources;
  }
  return input.allowAllFallback ? repos.gitSource.listAllActive() : [];
}

export async function collectGitHubSourceWebhookSecrets(input: {
  installationId?: number;
  appId?: number;
  allowAllFallback?: boolean;
}): Promise<string[]> {
  const sources = await listGitHubSourcesForWebhook(input);
  const secrets = new Set<string>();
  for (const source of sources) {
    try {
      secrets.add(readGitHubSourceSecrets(source).webhookSecret);
    } catch {
      // An unreadable source is unusable and contributes no candidate. Never
      // treat ciphertext as a secret or log it.
    }
  }
  return [...secrets];
}
