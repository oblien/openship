import { AppError, NotFoundError } from "@repo/core";
import { repos, type ContainerRegistry } from "@repo/db";
import { decryptSecretField, encryptSecretField } from "../../lib/credential-encryption";
import type { TCreateContainerRegistryBody, TUpdateContainerRegistryBody } from "./registry.schema";

export interface SerializedContainerRegistry {
  id: string;
  name: string;
  registryUrl: string;
  repositoryPrefix: string | null;
  username: string | null;
  hasCredentials: boolean;
  insecure: boolean;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeRegistryHost(value: string): string {
  const raw = value.trim().replace(/\/$/, "");
  const parsed = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new AppError("Registry address must contain only a host and optional port.", 400, "REGISTRY_URL_INVALID");
  }
  const host = parsed.host.toLowerCase();
  if (!host || /[\s\u0000-\u001f]/.test(host)) {
    throw new AppError("Registry address is invalid.", 400, "REGISTRY_URL_INVALID");
  }
  return host;
}

function normalizePrefix(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(normalized) || normalized.includes("//") || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new AppError("Registry namespace must be a relative slash-separated repository prefix.", 400, "REGISTRY_PREFIX_INVALID");
  }
  return normalized;
}

function assertCredentialPair(username: string | null | undefined, credentialsEnc: string | null | undefined): void {
  if (!!username !== !!credentialsEnc) {
    throw new AppError(
      "A registry login needs both a username and credential, or neither for a public registry.",
      400,
      "REGISTRY_CREDENTIALS_INCOMPLETE",
    );
  }
}

function bearerChallenge(value: string | null, insecure: boolean): URL | null {
  if (!value || !/^Bearer\s+/i.test(value)) return null;
  const attributes = Object.fromEntries(
    [...value.matchAll(/([a-z]+)="([^"]*)"/gi)].map((match) => [match[1]!.toLowerCase(), match[2]!]),
  );
  if (!attributes.realm) return null;
  let realm: URL;
  try {
    realm = new URL(attributes.realm);
  } catch {
    return null;
  }
  if (realm.protocol !== "https:" && !(insecure && realm.protocol === "http:")) return null;
  if (attributes.service) realm.searchParams.set("service", attributes.service);
  // `/v2/` does not name a repository, so no scope is needed to verify login.
  return realm;
}

export function serializeContainerRegistry(row: ContainerRegistry): SerializedContainerRegistry {
  return {
    id: row.id,
    name: row.name,
    registryUrl: row.registryUrl,
    repositoryPrefix: row.repositoryPrefix,
    username: row.username,
    hasCredentials: !!row.credentialsEnc,
    insecure: row.insecure,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyError: row.lastVerifyError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function verifyRegistryConnection(row: ContainerRegistry): Promise<void> {
  const credentials = decryptSecretField(row.credentialsEnc);
  assertCredentialPair(row.username, credentials);
  const scheme = row.insecure ? "http" : "https";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const basic = credentials && row.username
      ? `Basic ${Buffer.from(`${row.username}:${credentials}`).toString("base64")}`
      : undefined;
    const request = (authorization?: string) => fetch(`${scheme}://${row.registryUrl}/v2/`, {
      method: "GET",
      redirect: "error",
      headers: authorization ? { Authorization: authorization } : undefined,
      signal: controller.signal,
    });
    const response = await request(basic);
    if (response.ok) return;
    const realm = bearerChallenge(response.headers.get("www-authenticate"), row.insecure);
    if (!realm || !basic) {
      throw new AppError("Registry rejected the connection or supplied credentials.", 400, "REGISTRY_CONNECTION_FAILED");
    }
    // Docker Registry v2 commonly exchanges a Basic robot credential for a
    // short-lived Bearer token. The token remains in this scope only and is
    // never stored, logged, or returned to the caller.
    const tokenResponse = await fetch(realm, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: basic },
      signal: controller.signal,
    });
    if (!tokenResponse.ok) {
      throw new AppError("Registry rejected the connection or supplied credentials.", 400, "REGISTRY_CONNECTION_FAILED");
    }
    const payload = await tokenResponse.json().catch(() => null) as { token?: unknown; access_token?: unknown } | null;
    const token = typeof payload?.token === "string" ? payload.token : typeof payload?.access_token === "string" ? payload.access_token : null;
    if (!token || !(await request(`Bearer ${token}`)).ok) {
      throw new AppError("Registry rejected the connection or supplied credentials.", 400, "REGISTRY_CONNECTION_FAILED");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("OpenShip could not connect to this registry.", 400, "REGISTRY_CONNECTION_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

export function createContainerRegistryService() {
  return {
    async list(organizationId: string) {
      return (await repos.containerRegistry.listByOrganization(organizationId)).map(serializeContainerRegistry);
    },

    async create(organizationId: string, input: TCreateContainerRegistryBody) {
      const username = input.username?.trim() || null;
      const credentialsEnc = encryptSecretField(input.credentials ?? undefined);
      assertCredentialPair(username, credentialsEnc);
      const row = await repos.containerRegistry.create({
        organizationId,
        name: input.name.trim(),
        registryUrl: normalizeRegistryHost(input.registryUrl),
        repositoryPrefix: normalizePrefix(input.repositoryPrefix),
        username,
        credentialsEnc,
        insecure: input.insecure ?? false,
      });
      return serializeContainerRegistry(row);
    },

    async update(id: string, organizationId: string, input: TUpdateContainerRegistryBody) {
      const existing = await repos.containerRegistry.getInOrganization(id, organizationId);
      if (!existing) throw new NotFoundError("Container registry", id);
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.registryUrl !== undefined) patch.registryUrl = normalizeRegistryHost(input.registryUrl);
      if (input.repositoryPrefix !== undefined) patch.repositoryPrefix = normalizePrefix(input.repositoryPrefix);
      if (input.username !== undefined) patch.username = input.username?.trim() || null;
      if (input.credentials !== undefined) patch.credentialsEnc = encryptSecretField(input.credentials ?? undefined);
      if (input.insecure !== undefined) patch.insecure = input.insecure;
      assertCredentialPair(
        "username" in patch ? patch.username as string | null : existing.username,
        "credentialsEnc" in patch ? patch.credentialsEnc as string | null : existing.credentialsEnc,
      );
      const row = await repos.containerRegistry.updateInOrganization(id, organizationId, patch);
      if (!row) throw new NotFoundError("Container registry", id);
      return serializeContainerRegistry(row);
    },

    async test(id: string, organizationId: string) {
      const row = await repos.containerRegistry.getInOrganization(id, organizationId);
      if (!row) throw new NotFoundError("Container registry", id);
      try {
        await verifyRegistryConnection(row);
        const updated = await repos.containerRegistry.updateInOrganization(id, organizationId, {
          lastVerifiedAt: new Date(), lastVerifyError: null,
        });
        return { registry: serializeContainerRegistry(updated ?? row), ok: true };
      } catch (error) {
        const message = error instanceof AppError ? error.message : "OpenShip could not connect to this registry.";
        const updated = await repos.containerRegistry.updateInOrganization(id, organizationId, { lastVerifyError: message });
        throw new AppError(message, 400, "REGISTRY_CONNECTION_FAILED");
      }
    },

    async remove(id: string, organizationId: string) {
      const deleted = await repos.containerRegistry.deleteInOrganization(id, organizationId);
      if (!deleted) throw new NotFoundError("Container registry", id);
    },
  };
}

export const containerRegistryService = createContainerRegistryService();
