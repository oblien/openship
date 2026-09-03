/**
 * Wildcard Domain Management Service.
 *
 * Manages operator-configured wildcard domains (*.apps.example.com),
 * handles automated Cloudflare DNS A-record provisioning for the wildcard,
 * and generates collision-proof subdomains for projects.
 */

import { randomBytes } from "crypto";
import { repos, type WildcardDomain } from "@repo/db";
import { ConflictError, NotFoundError, ValidationError } from "@repo/core";
import type { RequestContext } from "../../lib/request-context";
import { env } from "../../config/env";
import * as dnsCredentialService from "../dns/dns-credential.service";
import { cloudflareDnsProvider } from "../dns/providers/cloudflare.provider";

export interface CreateWildcardDomainInput {
  domain: string; // e.g. "*.apps.example.com" or "apps.example.com"
  isDefault?: boolean;
  autoDns?: boolean;
  dnsCredentialId?: string;
}

/** Normalize input into "*.apex.com" and "apex.com" */
export function normalizeWildcardInput(raw: string): { domain: string; apex: string } {
  let cleaned = raw.trim().toLowerCase().replace(/^\*\./, "");
  if (!cleaned) {
    throw new ValidationError("Domain is required.");
  }
  // Validate domain format
  const pattern = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!pattern.test(cleaned)) {
    throw new ValidationError(`"${raw}" is not a valid domain name.`);
  }
  return {
    domain: `*.${cleaned}`,
    apex: cleaned,
  };
}

export async function listWildcardDomains(): Promise<WildcardDomain[]> {
  return repos.wildcardDomain.list();
}

export async function getDefaultWildcardDomain(): Promise<WildcardDomain | undefined> {
  const defaultDomain = await repos.wildcardDomain.findByDefault();
  if (defaultDomain) return defaultDomain;

  // If none explicitly set default, return first registered
  const all = await repos.wildcardDomain.list();
  return all[0];
}

export async function addWildcardDomain(
  ctx: RequestContext,
  input: CreateWildcardDomainInput,
): Promise<WildcardDomain> {
  const { domain, apex } = normalizeWildcardInput(input.domain);

  const existing = await repos.wildcardDomain.findByDomain(domain);
  if (existing) {
    throw new ConflictError(`Wildcard domain "${domain}" is already registered.`);
  }

  let dnsZoneId: string | undefined;
  let dnsRecordId: string | undefined;
  let dnsProvider = "manual";

  // If autoDns requested and a DNS credential exists
  if (input.autoDns) {
    const creds = await dnsCredentialService.listCredentials(ctx.organizationId);
    const targetCred = input.dnsCredentialId
      ? creds.find((c) => c.id === input.dnsCredentialId)
      : creds.find((c) => c.provider === "cloudflare");

    if (targetCred) {
      dnsProvider = targetCred.provider;
      const serverIp = env.SERVER_IP || "127.0.0.1";
      const decrypted = await dnsCredentialService.resolveDecryptedCredential(
        ctx.organizationId,
        targetCred.id,
      );

      if (decrypted) {
        try {
          const zone = await cloudflareDnsProvider.findZone(decrypted, apex);
          if (zone) {
            dnsZoneId = zone.id;
            const record = await cloudflareDnsProvider.upsertRecord(decrypted, zone.id, {
              type: "A",
              name: domain,
              content: serverIp,
              proxied: false,
              ttl: 1, // Auto
            });
            dnsRecordId = record.id;
          }
        } catch (err) {
          console.warn(`[WildcardDomain] Failed to auto-provision DNS record for ${domain}:`, err);
        }
      }
    }
  }

  const existingCount = (await repos.wildcardDomain.list()).length;
  const isDefault = input.isDefault ?? existingCount === 0;

  const id = `wd_${randomBytes(12).toString("hex")}`;
  const row = await repos.wildcardDomain.create({
    id,
    domain,
    apex,
    isDefault,
    dnsProvider,
    dnsZoneId,
    dnsRecordId,
    sslStatus: "none",
  });

  return row;
}

export async function setDefaultWildcardDomain(id: string): Promise<WildcardDomain> {
  const updated = await repos.wildcardDomain.setDefault(id);
  if (!updated) {
    throw new NotFoundError("Wildcard domain", id);
  }
  return updated;
}

export async function deleteWildcardDomain(
  ctx: RequestContext,
  id: string,
): Promise<void> {
  const row = await repos.wildcardDomain.findById(id);
  if (!row) {
    throw new NotFoundError("Wildcard domain", id);
  }

  // If DNS record was managed by Cloudflare, clean it up
  if (row.dnsProvider === "cloudflare" && row.dnsZoneId && row.dnsRecordId) {
    try {
      const creds = await dnsCredentialService.listCredentials(ctx.organizationId);
      const cfCred = creds.find((c) => c.provider === "cloudflare");
      if (cfCred) {
        const decrypted = await dnsCredentialService.resolveDecryptedCredential(
          ctx.organizationId,
          cfCred.id,
        );
        if (decrypted) {
          await cloudflareDnsProvider.deleteRecord(decrypted, row.dnsZoneId, row.dnsRecordId);
        }
      }
    } catch (err) {
      console.warn(`[WildcardDomain] Failed to delete DNS record for ${row.domain}:`, err);
    }
  }

  await repos.wildcardDomain.delete(id);
}

/**
 * Generates a collision-proof random subdomain under the active wildcard domain.
 * Format: ${slug}-${randomSuffix}.${wildcardApex}
 * Example: "api-e8f19a.apps.example.com"
 */
export async function generateCollisionProofSubdomain(
  projectSlug: string,
  wildcardDomainId?: string,
): Promise<string | null> {
  const wildcard = wildcardDomainId
    ? await repos.wildcardDomain.findById(wildcardDomainId)
    : await getDefaultWildcardDomain();

  if (!wildcard) {
    // Fallback to env.HOST_DOMAIN if configured
    if (env.HOST_DOMAIN) {
      const randomSuffix = randomBytes(3).toString("hex");
      return `${projectSlug}-${randomSuffix}.${env.HOST_DOMAIN}`;
    }
    return null;
  }

  const randomSuffix = randomBytes(3).toString("hex"); // 6 alphanumeric characters
  return `${projectSlug}-${randomSuffix}.${wildcard.apex}`;
}
