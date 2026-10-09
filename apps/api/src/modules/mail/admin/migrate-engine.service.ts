/**
 * Service to migrate a legacy host-native mail engine to a containerized engine.
 */

import { detectMailEngine, ensureContainerMail } from "@repo/adapters";
import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";

export async function migrateMailEngineToContainer(
  serverId: string,
): Promise<{ migrated: boolean; message: string }> {
  return sshManager.withExecutor(serverId, async (executor) => {
    const probe = await detectMailEngine(executor);

    if (probe.flavor === "container") {
      return { migrated: false, message: "Mail server is already running in container mode." };
    }

    const state = await readState(executor);
    if (!state) {
      throw new Error("Mail server state not found — cannot migrate.");
    }

    // 1. Stop and disable legacy host-native mail daemons
    await executor.exec("systemctl stop postfix dovecot amavis iredapd 2>/dev/null || true");
    await executor.exec("systemctl disable postfix dovecot amavis iredapd 2>/dev/null || true");

    // 2. Provision and start the containerized mail engine + DB sidecar
    const logs: string[] = [];
    const result = await ensureContainerMail(executor, {
      domain: state.domain,
      secrets: state.secrets ?? {},
      onLog: (l) => logs.push(l.message),
    });

    return {
      migrated: true,
      message: `Mail server migrated successfully to container mode (image: ${result.image}).`,
    };
  });
}
