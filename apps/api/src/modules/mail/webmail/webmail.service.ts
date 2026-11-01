/**
 * Webmail target discovery — which servers a webmail can be deployed to.
 *
 * The install itself lives in
 * [webmail-install.service.ts](./webmail-install.service.ts), and its status is
 * read from the project row, not from here.
 */

import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { assertResourceInOrg } from "@repo/platform/engine/lib/resource-access";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";

// ─── Targets discovery ──────────────────────────────────────────────────────

export interface WebmailTargetOption {
  /** The mail host, another connected host, or a real managed Cloud server. */
  kind: "mail" | "server" | "opshcloud";
  /** Server identity from the shared destination inventory. */
  serverId: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

/** Reuse the authorized destination inventory instead of inventing a Cloud target. */
export async function listWebmailTargets(
  mailServerId: string,
  ctx: ExecutionContext,
): Promise<WebmailTargetOption[]> {
  const mailServer = await repos.server.get(mailServerId);
  assertResourceInOrg(mailServer, "mail_server", ctx.organizationId, mailServerId);
  const {
    data: { servers },
  } = await getPlatformKernel().servers.destinations(ctx);
  const ordered = [...servers].sort(
    (a, b) => Number(b.id === mailServerId) - Number(a.id === mailServerId),
  );
  return ordered.map((server) => ({
    kind: server.id === mailServerId ? "mail" : server.managed ? "opshcloud" : "server",
    serverId: server.id,
    label: server.name || server.sshHost || server.id,
    description: server.managed ? "Managed Cloud server" : (server.sshHost ?? undefined),
    ...(server.source === "cloud"
      ? {
          disabled: true,
          disabledReason: "Connect this managed server in Servers before deploying webmail.",
        }
      : {}),
  }));
}
