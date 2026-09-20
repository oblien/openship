import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
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
import { platform } from "../../lib/platform-config";
import { isLocalHostRow } from "../../lib/box-org";
import { resolveEffectiveTarget, type DeploymentMeta } from "../../lib/deployment-runtime";
import * as service from "./domain.service";

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

/** Refuse host work before the retained best-effort TLS paths can swallow a policy error. */
export async function domainExecution(ctx: ExecutionContext, id: string, verifying = false) {
  if (process.env.OPENSHIP_NATIVE !== "true" || process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION === "true") return;
  const domain = await service.getDomain(ctx, id);
  if (verifying && (domain.verified || domain.externalIngress)) return;
  const project = domain.projectId ? await repos.project.findById(domain.projectId) : null;
  if (!project || project.organizationId !== ctx.organizationId) throw new NotFoundError("Domain", id);
  const deployment = project.activeDeploymentId ? await findActiveDeployment(project) : null;
  const meta = (deployment?.meta ?? {}) as DeploymentMeta;
  if (resolveEffectiveTarget(platform().target, meta) === "cloud") return;
  if (meta.serverId) {
    const server = await repos.server.getInOrganization(meta.serverId, ctx.organizationId);
    if (server && !await isLocalHostRow(server)) return;
  }
  throw new AppError("Host execution is disabled by this native installation's policy", 403, "HOST_EXECUTION_DISABLED");
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
  await domainExecution(ctx, id, true);
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
