import { canLinkGlab, connectGlab } from "../gitlab/cli";
import { CREDENTIAL_PROVIDERS, supportsConnectionOAuth } from "@repo/core";
import type { CredentialDependencies } from "../../../credentials";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { requireOrganizationAdmin } from "../../lib/organization-authorization";
import { hasVerifier } from "./verify";
import * as service from "./credential.service";

import {
  beginConnectionAuthorization,
  completeConnectionAuthorization,
  connectionAuthorizationAvailable,
} from "./connection-authorization";

/** Retained verification/encryption plus transport-independent audit and membership policy. */
export const credentialDependencies: CredentialDependencies = {
  requireAdmin: requireOrganizationAdmin,
  collection: {
    async listProviders(ctx) {
      const hostCli = await canLinkGlab(ctx);
      return CREDENTIAL_PROVIDERS.filter((provider) => hasVerifier(provider.id)).map((provider) => ({
        ...provider,
        ...(supportsConnectionOAuth(provider.id) && {
          authorization: {
            available: connectionAuthorizationAvailable(provider.id),
            ...(provider.id === "gitlab" && hostCli && { hostCli: true }),
          },
        }),
      }));
    },
    async connectCli(ctx, { name }) {
      const credential = await connectGlab(ctx, name);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "credential.created", resourceType: "credential", resourceId: credential.id,
        after: { provider: credential.provider, name: credential.name, authorization: "host-cli" },
      });
      return credential;
    },
    list: (ctx ) => service.listCredentials(ctx.organizationId),
    authorize: beginConnectionAuthorization,
    async completeAuthorization(ctx, input) {
      const credential = await completeConnectionAuthorization(ctx, input);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "credential.created",
        resourceType: "credential",
        resourceId: credential.id,
        after: { provider: credential.provider, name: credential.name, authorization: "oauth" },
      });
      return credential;
    },
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
