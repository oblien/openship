"use client";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { ManagementPlan } from "./ManagementPlan";
import { useManagementPlan } from "./useManagementPlan";

/** Shared by the page and inline connection dialog. The API enforces the same
 * allowance under the server inventory lock, including simultaneous connects. */
type ManagementAccessProps = {
  children: React.ReactNode;
  serverId?: string;
};

export function ManagementAccess(props: ManagementAccessProps) {
  const scope = useResourceScope();
  return <ScopedManagementAccess key={scope} {...props} />;
}

function ScopedManagementAccess({ children, serverId }: ManagementAccessProps) {
  const resource = useManagementPlan({ refreshIdle: false });
  const { data, loading, error } = resource;
  if (loading || error || !data?.active || (!serverId && data.connectedServers >= data.serverLimit))
    return <ManagementPlan resource={resource} embedded />;
  return children;
}
