"use client";

import { formatCpuCores, formatMemoryMb } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { BlurIp } from "@/components/BlurIp";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { cloudSpacePlanLabel } from "@/lib/cloud-spaces";
import { usePlatform } from "@/context/PlatformContext";
import { DESKTOP_LOCAL_DEPLOY_ENABLED } from "@/hooks/useLocalDeployGate";
import type { ServerInfo } from "@/lib/api/system";
import { ManagedServerStatus } from "@/components/servers/managed/ManagedServerStatus";

/** The wizard's server row, shared by connected and managed destinations. */
export function ServerRowContent({ server, active = false, details = "capacity", showStatus = false }: { server: ServerInfo; active?: boolean; details?: "capacity" | "plan"; showStatus?: boolean }) {
  const { t, locale } = useI18n();
  const { deployMode } = usePlatform();
  const localComingSoon = server.isLocal && deployMode === "desktop" && !DESKTOP_LOCAL_DEPLOY_ENABLED;
  const managed = server.managed;
  const copy = t.billing.workspaces;
  return (
    <>
      <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${active ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
        <Icon name={managed ? "cloud" : "server"} className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-start">
        <span className="truncate text-sm font-medium text-foreground">
          {server.name || server.sshHost || server.id}
          {server.isLocal && <span className="ms-2 rounded bg-info/10 px-1.5 py-0.5 text-xs text-info">{t.deploy.targetStep.thisServerBadge}</span>}
          {server.gpu?.available && <span className="ms-2 rounded bg-success/10 px-1.5 py-0.5 text-xs text-success">{t.deploy.targetStep.gpuBadge}</span>}
        </span>
        <span className="truncate text-xs font-normal text-muted-foreground">
          {managed ? (
            <>
              {details === "plan" && <>{cloudSpacePlanLabel(managed.planTierId, locale, t.servers.resources.customPlan)}{" · "}</>}
              {interpolate(managed.projectCount === 1 ? copy.oneProject : copy.projectCount, { count: String(managed.projectCount) })}
              {details === "capacity" && (managed.resources ? <>{" · "}<bdi dir="ltr">{formatCpuCores(managed.resources.cpuCores)} · {formatMemoryMb(managed.resources.memoryMb)} {t.deploy.power.ram}</bdi></>
                : managed.state === "needs_plan" ? ` · ${copy.states.needs_plan}` : "")}
            </>
          ) : localComingSoon ? "Running here is coming soon — connect a server"
            : server.isLocal ? t.deploy.targetStep.thisServerHost
              : <bdi dir="ltr">{server.sshUser || "root"}@<BlurIp>{server.sshHost}</BlurIp>:{server.sshPort || 22}</bdi>}
        </span>
      </span>
      {managed && showStatus && <ManagedServerStatus workspace={managed} compact />}
    </>
  );
}

interface ServerPickerProps<T extends ServerInfo> {
  servers: T[];
  selectedId?: string | null;
  onSelect: (server: T) => void;
  onAddServer?: () => void;
  addServerLabel?: string;
  label?: string;
  showLabel?: boolean;
  disabled?: boolean;
  details?: "capacity" | "plan";
  showStatus?: boolean;
}

/** Existing wizard picker, using the shared menu's positioning and keyboard handling. */
export function ServerPicker<T extends ServerInfo>({
  servers, selectedId, onSelect, onAddServer, addServerLabel, label, showLabel = true, disabled, details = "capacity", showStatus = false,
}: ServerPickerProps<T>) {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const copy = t.deploy.targetStep;
  const managedOnly = servers.length > 0 && servers.every(server => server.managed);
  const hostLabels = selfHosted && !managedOnly;
  const name = label ?? (hostLabels ? copy.chooseServer : t.servers.resources.selectPool);
  return (
    <div className="space-y-2">
      {showLabel && <p className="text-sm font-medium text-muted-foreground">{name}</p>}
      <CustomSelect
        aria-label={name}
        value={selectedId ?? ""}
        disabled={disabled}
        placeholder={name}
        triggerClassName="rounded-lg border-0 bg-muted/40 px-3 py-2.5 text-start hover:bg-muted/60"
        options={servers.map(server => ({
          value: server.id,
          label: server.name || server.sshHost || server.id,
          description: server.managed ? undefined : `${server.sshUser || "root"}@${server.sshHost}:${server.sshPort || 22}`,
        }))}
        renderOption={(option, selected) => <ServerRowContent server={servers.find(server => server.id === option.value)!} active={selected} details={details} showStatus={showStatus} />}
        onChange={id => {
          const server = servers.find(server => server.id === id);
          if (server) onSelect(server);
        }}
        searchable
        searchPlaceholder={hostLabels ? copy.searchPlaceholder : t.servers.resources.selectPool}
        emptySearchMessage={() => hostLabels ? copy.noServersMatch : t.servers.resources.notFound}
        footerAction={onAddServer ? {
          label: addServerLabel ?? (hostLabels ? copy.addServer : t.servers.resources.addCapacity),
          icon: <Icon name="plus" className="size-4" />,
          onClick: onAddServer,
        } : undefined}
      />
    </div>
  );
}
