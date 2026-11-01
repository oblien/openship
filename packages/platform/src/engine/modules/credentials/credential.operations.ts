import { CREDENTIAL_PROVIDERS } from "@repo/core";
import type { CredentialDependencies } from "../../../credentials";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { requireOrganizationAdmin } from "../../lib/organization-authorization";
import { hasVerifier } from "./verify";
import * as service from "./credential.service";

/** Retained verification/encryption plus transport-independent audit and membership policy. */
export const credentialDependencies: CredentialDependencies = {
  requireAdmin: requireOrganizationAdmin,
  collection: {
    listProviders: async () => CREDENTIAL_PROVIDERS.filter(provider => hasVerifier(provider.id)),
    list: ctx => service.listCredentials(ctx.organizationId),
    async create(ctx, input) {
      const credential = await service.createCredential(ctx.organizationId, input);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "credential.created", resourceType: "credential", resourceId: credential.id,
        after: { provider: credential.provider, name: credential.name, selector: credential.selector } });
      return credential;
    },
  },
  resources: {
    get: (ctx, id) => service.getCredential(ctx.organizationId, id),
    async update(ctx, id, input) {
      const before = await service.getCredential(ctx.organizationId, id);
      const credential = await service.updateCredential(ctx.organizationId, id, input);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "credential.updated", resourceType: "credential", resourceId: id,
        before: { name: before.name, selector: before.selector },
        after: { name: credential.name, selector: credential.selector, secretRotated: Object.keys(input.values ?? {}).length > 0 } });
      return credential;
    },
    async remove(ctx, id) {
      const before = await service.getCredential(ctx.organizationId, id);
      await service.deleteCredential(ctx.organizationId, id);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "credential.deleted", resourceType: "credential", resourceId: id,
        before: { provider: before.provider, name: before.name, selector: before.selector } });
      return { success: true };
    },
    async verify(ctx, id) {
      const credential = await service.verifyCredential(ctx.organizationId, id);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "credential.verified", resourceType: "credential", resourceId: id,
        after: { provider: credential.provider, name: credential.name, status: credential.status } });
      return credential;
    },
  },
};
