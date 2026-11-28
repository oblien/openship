import { isDedicatedMailNamespace } from "../managed-mail/dedicated-contract";
import { db, eq, repos, schema } from "@repo/db";

type BillingOwner =
  | { kind: "hosting"; organizationId: string; workspaceId: string | null }
  | { kind: "management"; organizationId: string }
  | { kind: "mail"; organizationId: string }
  | { kind: "actions"; organizationId: string };

/** Resolve financial ownership from persisted records, never webhook metadata
 * or a caller-provided namespace. Ambiguous ownership must not move funds. */
export async function findBillingOwnerByNamespace(namespace: string): Promise<BillingOwner | null> {
  const [workspace, [row], actions, management, mail] = await Promise.all([
    repos.cloudWorkspace.findByNamespace(namespace),
    db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.oblienNamespace, namespace))
      .limit(1),
    repos.actionBilling.byNamespace(namespace),
    repos.managementBilling.byNamespace(namespace),
    isDedicatedMailNamespace(namespace) ? repos.managedMail.orderByNamespace(namespace) : namespace.startsWith("openship-mail-") ? repos.managedMail.billingOwner(namespace) : null,
  ]);
  // The native Apps destination and the paid mail order intentionally reference the same VM.
  if (workspace && isDedicatedMailNamespace(namespace) && !row && !actions && !management &&
      mail?.organizationId === workspace.organizationId && "cloudServerId" in mail && mail.cloudServerId && !workspace.remote) {
    const vm = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: workspace.id }, workspace.organizationId);
    if (vm?.workspaceId === mail.cloudServerId && vm.namespace === namespace)
      return { kind: "mail", organizationId: workspace.organizationId };
  }
  if (Number(!!workspace) + Number(!!row) + Number(!!actions) + Number(!!management) + Number(!!mail) > 1)
    throw new Error("Cloud namespace has ambiguous billing ownership");
  if (mail?.organizationId) return { kind: "mail", organizationId: mail.organizationId };
  if (management) return { kind: "management", organizationId: management.organizationId };
  return actions
    ? { kind: "actions", organizationId: actions.organizationId }
    : workspace
      ? { kind: "hosting", organizationId: workspace.organizationId, workspaceId: workspace.id }
      : row
        ? { kind: "hosting", organizationId: row.id, workspaceId: null }
        : null;
}
