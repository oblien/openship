import { OperationError } from "@repo/contracts";
import type { SystemDependencies } from "../../../system";
import type { ExecutionContext } from "../../../context";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { assertNativeHostExecution } from "../../native/execution-policy";
import { scanEdgeOrphans, removeEdgeOrphan } from "../../lib/edge-orphans.service";
import { browseDirectories } from "./filesystem.operations";
import { inspectSystemHealth } from "./system-health";
import { getSystemInfo } from "./system-info";
import * as settings from "./settings.operations";
import { assertSelfHosted } from "./server-access";

function record(ctx: ExecutionContext, action: "write" | "admin", fields?: string[]) {
  audit.recordAsync(operationAuditContext(ctx), { eventType: `settings:${action}`, resourceType: "settings", resourceId: "*", after: fields ? { fields } : null });
}

export const systemDependencies: SystemDependencies = {
  instanceAuthorization,
  info: getSystemInfo,
  operations: {
    browse: (_ctx, input) => browseDirectories(input),
    health: () => inspectSystemHealth(),
    getSettings: settings.getSetup,
    getEmailSettings: settings.getEmailSettings,
    async updateSettings(ctx, input) {
      const result = await settings.updateSettings(ctx, input);
      record(ctx, "write", Object.keys(input));
      return result;
    },
    async updateEmailSettings(ctx, input) {
      const result = await settings.updateEmailSettings(ctx, input);
      record(ctx, "write", Object.keys(input));
      return result;
    },
    async sendTestEmail(ctx, input) {
      const result = await settings.sendTestEmail(ctx, input);
      if (result.ok) record(ctx, "write");
      return result;
    },
    async resetSettings(ctx) {
      const result = await settings.deleteSettings(ctx);
      record(ctx, "admin");
      return result;
    },
    async listUntrackedEdgeSites() {
      assertSelfHosted();
      assertNativeHostExecution();
      return scanEdgeOrphans();
    },
    async removeUntrackedEdgeSite(ctx, input) {
      assertSelfHosted();
      assertNativeHostExecution();
      const hostname = input.hostname.trim();
      if (!hostname) throw new OperationError("`hostname` is required", 400, "HOSTNAME_REQUIRED");
      const result = await removeEdgeOrphan(hostname);
      if (!result.removed) throw new OperationError(result.reason ?? "Could not remove", 409, "EDGE_ORPHAN_REFUSED");
      record(ctx, "admin");
      return { removed: true, hostname };
    },
  },
};
