"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { BlurIp } from "@/components/BlurIp";
import type { TransferManifest } from "@/lib/api/data-transfer";

/** Show the runtime dependencies from the downloaded archive, not an earlier preview. */
export function TransferRequirements({ manifest }: { manifest?: TransferManifest }) {
  const servers = manifest?.servers ?? [];
  const accounts = manifest?.cloudAccounts ?? [];
  const localProjects = (manifest?.projects ?? []).filter(
    (project) => !project.serverId && !project.workspaceId,
  );

  return (
    <div className="space-y-3 rounded-xl bg-muted/40 p-4">
      <div className="flex items-start gap-2.5">
        <UiIcon name="server" className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <h4 className="text-sm font-medium text-foreground">Required on the destination</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Use the same servers or OpenShip Cloud account shown below. They are required to
            reconnect the imported project to its existing workloads.
          </p>
        </div>
      </div>
      {(servers.length > 0 || accounts.length > 0 || localProjects.length > 0) && (
        <ul className="divide-y divide-border/50">
          {servers.map((server) => (
            <li key={server.id} className="flex items-start gap-3 py-3">
              <UiIcon name="server" className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{server.name}</p>
                <p className="mt-0.5 break-all text-xs text-muted-foreground">
                  {server.isLocal ? "Source control-plane host" : (
                    <BlurIp>{server.host}{server.port !== 22 ? `:${server.port}` : ""}</BlurIp>
                  )}
                  {server.jumpHost && <> · via <BlurIp>{server.jumpHost}</BlurIp></>}
                </p>
              </div>
            </li>
          ))}
          {localProjects.length > 0 && !servers.some((server) => server.isLocal) && (
            <li className="flex items-start gap-3 py-3">
              <UiIcon name="server" className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Source control-plane host</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Add this machine as a server on the destination and select it during import.
                </p>
              </div>
            </li>
          )}
          {accounts.map((account) => (
            <li key={account.organizationId} className="flex items-start gap-3 py-3">
              <UiIcon name="cloud" className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">OpenShip Cloud account</p>
                <p className="mt-0.5 break-all text-xs text-muted-foreground">
                  {account.email ? <BlurIp>{account.email}</BlurIp> : "Source account — reconnect it before importing."}
                </p>
                {!account.email && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    Workspaces: {(manifest?.projects ?? [])
                      .filter((project) => project.organizationId === account.organizationId && project.workspaceId)
                      .map((project) => project.workspaceId).filter((id, index, ids) => ids.indexOf(id) === index).join(", ")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Import the file from Settings → Instance on the destination. Container files, volumes,
        and database contents stay on their servers. Moving them to a different server requires
        migration or backup restore.
      </p>
    </div>
  );
}
