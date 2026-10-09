import { db, eq, repos, schema } from "@repo/db";

type BillingOwner =
  | { kind: "hosting"; organizationId: string; workspaceId: string | null }
  | { kind: "actions"; organizationId: string };

/** Resolve financial ownership from persisted records, never webhook metadata
 * or a caller-provided namespace. Ambiguous ownership must not move funds. */
export async function findBillingOwnerByNamespace(namespace: string): Promise<BillingOwner | null> {
  const [workspace, [row], actions] = await Promise.all([
    repos.cloudWorkspace.findByNamespace(namespace),
    db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.oblienNamespace, namespace))
      .limit(1),
    repos.actionBilling.byNamespace(namespace),
  ]);
  if (Number(!!workspace) + Number(!!row) + Number(!!actions) > 1)
    throw new Error("Cloud namespace has ambiguous billing ownership");
  return actions
    ? { kind: "actions", organizationId: actions.organizationId }
    : workspace
      ? { kind: "hosting", organizationId: workspace.organizationId, workspaceId: workspace.id }
      : row
        ? { kind: "hosting", organizationId: row.id, workspaceId: null }
        : null;
}
