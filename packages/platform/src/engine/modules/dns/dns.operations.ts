import { NotFoundError } from "@repo/core";
import type { DnsDependencies } from "../../../dns";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { describeDnsProviders } from "./registry";
import * as service from "./dns-credential.service";
import { requireOrganizationAdmin } from "../../lib/organization-authorization";

/** Credential policy and presentation are shared with the HTTP adapter. */
export const dnsDependencies: DnsDependencies = {
  requireAdmin: requireOrganizationAdmin,
  operations: {
    listProviders: async () => describeDnsProviders(),
    listCredentials: (ctx) => service.listCredentials(ctx.organizationId),
    async getCredential(ctx, id) {
      const credential = await service.getCredential(ctx.organizationId, id);
      if (!credential) throw new NotFoundError("DNS credential", id);
      return credential;
    },
    async addCredential(ctx, input) {
      const credential = await service.addCredential(ctx.organizationId, input);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "dns_credential.connected", resourceType: "dns_credential", resourceId: credential.id,
        after: { provider: credential.provider, name: credential.name },
      });
      return credential;
    },
    async removeCredential(ctx, id) {
      const credential = await service.getCredential(ctx.organizationId, id);
      if (!credential) throw new NotFoundError("DNS credential", id);
      await service.removeCredential(ctx.organizationId, id);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "dns_credential.disconnected", resourceType: "dns_credential", resourceId: id,
        before: { provider: credential.provider, name: credential.name },
      });
      return { success: true };
    },
    async verifyZone(ctx, { hostname }) {
      // Read-only lookup: a probe never disables credentials as a side effect.
      const lookup = await service.resolveDnsManager(ctx.organizationId, hostname);
      switch (lookup.status) {
        case "matched": return {
          matched: true, status: "matched", provider: lookup.manager.provider.name,
          credentialId: lookup.manager.credentialId, zoneName: lookup.manager.zone.name,
          zoneId: lookup.manager.zone.id,
        };
        case "unauthorized": return {
          matched: false, status: "unauthorized", credentialId: lookup.credentialId, message: lookup.reason,
        };
        case "unavailable": return { matched: false, status: "unavailable", message: lookup.reason };
        default: return {
          matched: false, status: "none", message: "No connected DNS provider manages this domain's zone.",
        };
      }
    },
  },
};
