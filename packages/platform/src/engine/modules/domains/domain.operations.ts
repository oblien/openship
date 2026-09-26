import { AppError, NotFoundError, ValidationError, safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { DomainDependencies } from "../../../domains";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { notification } from "../../lib/notification-dispatcher";
import { trackBackgroundWork } from "../../lib/background-work";
import { resolveProjectAuthority } from "../../lib/cloud/project-authority";
import * as service from "./domain.service";
import * as dnsChallenge from "./domain-dns-challenge.service";
import { manageDomainSsl, needsDomainSslCheck } from "../../lib/domain-ssl";
import { resolveManagedHostname } from "../../lib/routing-domains";
import { domainExecution } from "./domain-execution";
export { domainExecution } from "./domain-execution";

function record(ctx: ExecutionContext, id: string, eventType: string, after: unknown) {
  audit.recordAsync(operationAuditContext(ctx), { eventType, resourceType: "domain", resourceId: id, after });
}
async function projectAuthority(ctx: ExecutionContext, id: string) {
  if (ctx.scopeMode === "fixed" && await resolveProjectAuthority(id, ctx.organizationId) === "cloud")
    throw new AppError("This cloud link has no tenant mapping. Connect directly with the cloud organizationId.", 409, "CLOUD_SCOPE_UNAVAILABLE");
}
async function targetServer(ctx: ExecutionContext, id?: string) {
  if (id) await authorization.authorize({ ...ctx, scopeMode: "fixed" }, {
    resourceType: "server", resourceId: id, action: "read",
  });
}

function batchContext(ctx: ExecutionContext): service.DomainBatchContext {
  return async (id, action) => {
    let context: ExecutionContext;
    try {
      context = await authorization.authorize({ ...ctx, scopeMode: "fixed" }, {
        resourceType: "domain", resourceId: id, action: "write",
      });
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    await domainExecution(context, id, action === "verify");
    return context;
  };
}

async function verify(ctx: ExecutionContext, id: string, input: { force?: boolean }, onLog?: (line: string) => void) {
  await domainExecution(ctx, id, !input.force);
  const result = await service.verifyDomain(ctx, id, { ...input, onLog });
  record(ctx, id, result.verified ? "domain.verified" : "domain.verify_failed", {
    verified: result.verified, cnameVerified: result.cnameVerified, txtVerified: result.txtVerified,
  });
  if (!onLog && !result.verified) notification.emit({
    organizationId: ctx.organizationId, eventType: "domain.verification_failed", resourceType: "domain", resourceId: id,
    payload: { message: result.message ?? "Domain verification failed", cnameVerified: result.cnameVerified, txtVerified: result.txtVerified },
  });
  return result;
}

/** Finish the domain checks after a live routing repair. Reuse the interactive
 * authorization, verification and certificate paths, including native policy. */
export async function verifyProjectRoutingDomains(
  ctx: ExecutionContext,
  projectId: string,
  onLog?: (line: string) => void,
): Promise<string[]> {
  const rows = await service.listDomains(ctx, projectId);
  const services = rows.some((row) => row.serviceId)
    ? await repos.service.listByProject(projectId)
    : [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (
      row.domainType === "free" ||
      resolveManagedHostname(row.hostname).isManaged ||
      row.status === "removing"
    )
      continue;
    if (row.serviceId && !services.some((s) => s.id === row.serviceId && s.enabled && s.exposed))
      continue;
    if (row.verified && !needsDomainSslCheck(row)) continue;
    const log = (message: string) => onLog?.(`${row.hostname}: ${message}`);
    try {
      const context = await authorization.authorize(
        { ...ctx, scopeMode: "fixed" },
        {
          resourceType: "domain",
          resourceId: row.id,
          action: "write",
        },
      );
      let current = row;
      if (!row.verified) {
        log("Checking domain verification and HTTPS…");
        const result = await verify(context, row.id, {}, log);
        if (!result.verified) {
          warnings.push(
            `${row.hostname}: ${result.message || "Domain verification failed. Open the domain details to review DNS and HTTPS."}`,
          );
          continue;
        }
        current = await service.getDomain(context, row.id);
      }
      if (needsDomainSslCheck(current)) {
        await domainExecution(context, row.id);
        log("Checking or provisioning the HTTPS certificate…");
        const result = await manageDomainSsl(row.hostname, {
          action: "provision",
          projectId,
          onLog: log,
        });
        if (result.reason !== "not_local" && (!result.verified || !result.expiresAt)) {
          const failed = await repos.domain.findById(row.id);
          warnings.push(
            `${row.hostname}: ${failed?.lastVerifyError ?? "The HTTPS check failed. Open the domain details to retry."}`,
          );
          continue;
        }
      }
      log("Domain verification and HTTPS checks completed.");
    } catch (error) {
      const message = `${row.hostname}: ${safeErrorMessage(error)}`;
      onLog?.(message);
      warnings.push(message);
    }
  }
  return warnings;
}

export const domainDependencies: DomainDependencies = {
  collection: {
    async list(ctx, id) {
      await projectAuthority(ctx, id);
      return service.listDomains(ctx, id);
    },
    async create(ctx, id, input) {
      await projectAuthority(ctx, id);
      const result = await service.addDomain(ctx, { ...input, projectId: id });
      record(ctx, result.domain.id, "domain.added", {
        projectId: result.domain.projectId, hostname: result.domain.hostname, isPrimary: result.domain.isPrimary,
      });
      return result;
    },
  },
  resources: {
    get: service.getDomain,
    async remove(ctx, id) {
      await domainExecution(ctx, id);
      await service.removeDomain(ctx, id);
      record(ctx, id, "domain.removed", null);
      return { message: "domain removed" };
    },
    verify: (ctx, id, input = {}) => verify(ctx, id, input),
    async records(ctx, id, input = {}) {
      await targetServer(ctx, input.serverId);
      return service.getDomainRecords(ctx, id, input.serverId);
    },
    async dnsPlan(ctx, id, input = {}) {
      await targetServer(ctx, input.serverId);
      return service.planDomainDns(ctx, id, input.serverId);
    },
    async dnsApply(ctx, id, input = {}) {
      await targetServer(ctx, input.serverId);
      const result = await service.applyDomainDns(ctx, id, input.serverId);
      record(ctx, id, "domain.dns_provisioned", {
        provisioned: result.provisioned,
        applied: result.records.filter(r => r.outcome === "applied").length,
        failed: result.records.filter(r => r.outcome === "failed").length,
      });
      return result;
    },
    dnsChallenge: dnsChallenge.getDnsChallenge,
    async startDnsChallenge(ctx, id, input) {
      await domainExecution(ctx, id);
      const result = await dnsChallenge.startDnsChallenge(ctx, id, input);
      record(ctx, id, "domain:write", { operation: "startDnsChallenge", mode: input.mode, attemptId: result.id });
      return result;
    },
    async checkDnsChallenge(ctx, id, input) {
      await domainExecution(ctx, id);
      const result = await dnsChallenge.checkDnsChallenge(ctx, id, input.attemptId);
      record(ctx, id, "domain:write", { operation: "checkDnsChallenge", attemptId: result.id });
      return result;
    },
    async cancelDnsChallenge(ctx, id, input) {
      const result = await dnsChallenge.cancelDnsChallenge(ctx, id, input.attemptId);
      record(ctx, id, "domain:write", { operation: "cancelDnsChallenge", attemptId: result.id });
      return result;
    },
    async setPrimary(ctx, id) {
      const result = await service.setPrimaryDomain(ctx, id);
      record(ctx, id, "domain.set_primary", { projectId: result.projectId, hostname: result.hostname, isPrimary: true });
      return result;
    },
    async renewSsl(ctx, id) {
      await domainExecution(ctx, id);
      const result = await service.renewDomainSsl(ctx, id);
      record(ctx, id, "domain:write", { operation: "renewSsl", ...result });
      return result;
    },
    async verifySsl(ctx, id) {
      await domainExecution(ctx, id);
      const result = await service.verifyDomainSsl(ctx, id);
      record(ctx, id, "domain:write", { operation: "verifySsl", ...result });
      return result;
    },
    async uploadCert(ctx, id, input) {
      if (env.CLOUD_MODE) throw new NotFoundError("Operation");
      await domainExecution(ctx, id);
      const result = await service.uploadDomainCert(ctx, id, input);
      record(ctx, id, "domain.cert_uploaded", { domain: result.domain, issuer: result.issuer, expiresAt: result.expiresAt });
      return result;
    },
  },
  scoped: {
    async preview(ctx, input) {
      const hostname = input.hostname.trim().toLowerCase();
      if (!hostname) throw new ValidationError("hostname is required");
      await targetServer(ctx, input.serverId);
      return service.previewRecords(hostname, ctx.organizationId, input.includeWww === true, input.serverId);
    },
    async renewAllSsl(ctx) {
      const result = await service.renewOrgCerts(ctx, batchContext(ctx));
      record(ctx, "*", "domain:write", { operation: "renewAllSsl", renewed: result.renewed });
      return result;
    },
    async verifyPending(ctx, input = {}) {
      const result = await service.verifyPendingDomains({ ...input, organizationId: ctx.organizationId }, batchContext(ctx));
      record(ctx, "*", "domain:write", { operation: "verifyPending", verified: result.verified, total: result.total });
      return result;
    },
  },
  subscribe: (ctx, id, input) => (write) => {
    let closed = false;
    const emit = (event: string, data: unknown) => !closed && write(event, JSON.stringify(data));
    emit("session", { type: "session" });
    // Disconnecting stops delivery, not an in-flight certificate order. The
    // instance owns the work and drains it before closing its providers or DB.
    void trackBackgroundWork((async () => {
      try {
        const result = await verify(ctx, id, input, (message) => {
          emit("log", { type: "log", message, level: "info" });
        });
        emit("log", { type: "log", message: result.message ?? (result.verified ? "Verified." : "Not verified."), level: result.verified ? "info" : "error" });
        emit("complete", { type: "complete", status: result.verified ? "completed" : "failed" });
      } catch (error) {
        emit("log", { type: "log", message: safeErrorMessage(error), level: "error" });
        emit("complete", { type: "complete", status: "failed" });
      }
    })());
    return { success: true, unsubscribe: () => { closed = true; } };
  },
};
