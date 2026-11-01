import type { TokenDependencies } from "../../../tokens";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import * as service from "./token.service";
export const tokensDependencies: TokenDependencies = {
  collection: {
    list: service.list,
    async create(ctx, input) {
      const result = await service.create(ctx, input);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "settings:write", resourceType: "token", resourceId: result.id, after: { operation: "create", readOnly: result.readOnly, scoped: result.scoped } });
      return result;
    },
    authorizeMcpClient: service.authorizeMcpClient,
    listMcpClients: service.listMcpClients,
  },
  tokens: {
    async revoke(ctx, id) {
      const result = await service.revoke(ctx, id);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "settings:write", resourceType: "token", resourceId: id, after: { operation: "revoke" } });
      return result;
    },
    getMcpClient: service.getMcpClient,
    disconnectMcpClient: service.disconnectMcpClient,
  },
};
