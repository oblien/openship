import type { SslResult } from "@repo/adapters";
import { ForbiddenError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { platform } from "./controller-helpers";

export type DomainSslAction = "provision" | "renew";

interface DomainSslOptions {
  action: DomainSslAction;
  userId?: string;
  projectId?: string;
  includeWww?: boolean;
}

async function resolveAuthorizedDomain(hostname: string, opts: DomainSslOptions) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  if (!project) throw new NotFoundError("Domain", hostname);

  if (opts.userId && project.userId !== opts.userId) {
    throw new NotFoundError("Domain", hostname);
  }

  if (opts.projectId && domainRecord.projectId !== opts.projectId) {
    throw new NotFoundError("Domain", hostname);
  }

  if (!domainRecord.verified) {
    throw new ForbiddenError("Domain must be verified before SSL can be managed");
  }

  return { domainRecord, project };
}

async function persistSslResult(domainId: string, result: SslResult) {
  await repos.domain.updateSsl(domainId, {
    sslStatus: result.expiresAt ? "active" : "provisioning",
    sslIssuer: result.issuer,
    sslExpiresAt: result.expiresAt ? new Date(result.expiresAt) : undefined,
  });
}

async function executeSslAction(hostname: string, action: DomainSslAction): Promise<SslResult> {
  const { ssl } = platform();
  return action === "renew"
    ? ssl.renewCert(hostname)
    : ssl.provisionCert(hostname);
}

export async function manageDomainSsl(
  hostname: string,
  opts: DomainSslOptions,
): Promise<SslResult> {
  const { domainRecord } = await resolveAuthorizedDomain(hostname, opts);
  const result = await executeSslAction(domainRecord.hostname, opts.action);
  await persistSslResult(domainRecord.id, result);

  if (opts.includeWww) {
    const wwwHostname = `www.${domainRecord.hostname}`;
    const wwwRecord = await repos.domain.findByHostname(wwwHostname);

    if (wwwRecord && wwwRecord.projectId === domainRecord.projectId && wwwRecord.verified) {
      const wwwResult = await executeSslAction(wwwRecord.hostname, opts.action);
      await persistSslResult(wwwRecord.id, wwwResult);
    }
  }

  return result;
}