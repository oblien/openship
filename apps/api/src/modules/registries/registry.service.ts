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

async function verifyRegistry(row: ContainerRegistry): Promise<void> {
  const credentials = decryptSecretField(row.credentialsEnc);
  const scheme = row.insecure ? "http" : "https";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${scheme}://${row.registryUrl}/v2/`, {
      method: "GET",
      redirect: "error",
      headers: credentials && row.username
        ? { Authorization: `Basic ${Buffer.from(`${row.username}:${credentials}`).toString("base64")}` }
        : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
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
      const row = await repos.containerRegistry.create({
        organizationId,
        name: input.name.trim(),
        registryUrl: normalizeRegistryHost(input.registryUrl),
        repositoryPrefix: normalizePrefix(input.repositoryPrefix),
        username: input.username?.trim() || null,
        credentialsEnc: encryptSecretField(input.credentials ?? undefined),
        insecure: input.insecure ?? false,
      });
      return serializeContainerRegistry(row);
    },

    async update(id: string, organizationId: string, input: TUpdateContainerRegistryBody) {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.registryUrl !== undefined) patch.registryUrl = normalizeRegistryHost(input.registryUrl);
      if (input.repositoryPrefix !== undefined) patch.repositoryPrefix = normalizePrefix(input.repositoryPrefix);
      if (input.username !== undefined) patch.username = input.username?.trim() || null;
      if (input.credentials !== undefined) patch.credentialsEnc = encryptSecretField(input.credentials ?? undefined);
      if (input.insecure !== undefined) patch.insecure = input.insecure;
      const row = await repos.containerRegistry.updateInOrganization(id, organizationId, patch);
      if (!row) throw new NotFoundError("Container registry", id);
      return serializeContainerRegistry(row);
    },

    async test(id: string, organizationId: string) {
      const row = await repos.containerRegistry.getInOrganization(id, organizationId);
      if (!row) throw new NotFoundError("Container registry", id);
      try {
        await verifyRegistry(row);
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
