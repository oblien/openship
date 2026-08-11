/**
 * Webmail service - helpers shared by the webmail controller + bridge.
 *
 * The deploy itself lives in [webmail-project.service.ts](./webmail-project.service.ts);
 * this file holds the pieces that are not part of the deploy lifecycle:
 * picking a deploy target and reading the persisted install record off
 * the mail-state file.
 */

import { sshManager } from "../../../lib/ssh-manager";
import { repos } from "@repo/db";
import { readState, type MailWebmailState } from "../mail-state";

// ─── Targets discovery ──────────────────────────────────────────────────────

export interface WebmailTargetOption {
  /** "mail" → the mail server itself. "server" → another openship server. "opshcloud" → reserved. */
  kind: "mail" | "server" | "opshcloud";
  /** openship serverId. For "opshcloud" this is empty and disabled in UI. */
  serverId: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Build the list of places the webmail can be deployed to. The mail
 * server itself is always option #1; every other openship-managed
 * server follows. Opshcloud is listed as a coming-soon placeholder.
 */
export async function listWebmailTargets(
  mailServerId: string,
  organizationId: string,
): Promise<WebmailTargetOption[]> {
  // ORG-SCOPED: only this org's servers are valid deploy targets. The
  // route tag (mail_server:read with no :id param) only proves org
  // membership, not that `mailServerId` belongs to the org — so listing
  // the global server set here leaked every tenant's servers.
  const all = await repos.server.listByOrganization(organizationId);
  const mailServer = all.find((s) => s.id === mailServerId);
  const others = all.filter((s) => s.id !== mailServerId);

  const options: WebmailTargetOption[] = [];

  if (mailServer) {
    const label = mailServer.name || mailServer.sshHost || "Mail server";
    const description = mailServer.sshHost && mailServer.sshHost !== label
      ? `This mail server · ${mailServer.sshHost}`
      : "This mail server";
    options.push({
      kind: "mail",
      serverId: mailServer.id,
      label,
      description,
    });
  }

  for (const s of others) {
    options.push({
      kind: "server",
      serverId: s.id,
      label: s.name || s.sshHost || s.id,
      description: s.sshHost ?? undefined,
    });
  }

  options.push({
    kind: "opshcloud",
    serverId: "",
    label: "Opshcloud (managed)",
    description: "Managed hosting · we provision the VM, route the domain, and run the cert",
  });

  return options;
}

// ─── Status read ─────────────────────────────────────────────────────────────

/**
 * Read the persisted `webmail` block off the mail server's state file.
 * Used by the /emails overview tab so it keeps rendering the post-install
 * info (URL, version, hostname) regardless of whether the project row
 * exists. Returns null when not installed or unreachable.
 */
export async function getWebmailState(
  mailServerId: string,
): Promise<MailWebmailState | null> {
  try {
    const state = await sshManager.withExecutor(mailServerId, (exec) =>
      readState(exec),
    );
    if (!state?.webmail?.installed) return null;
    return state.webmail;
  } catch {
    return null;
  }
}
