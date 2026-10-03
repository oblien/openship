"use client";

import { formatCpuCores, formatMemoryMb } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { BlurIp } from "@/components/BlurIp";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { DESKTOP_LOCAL_DEPLOY_ENABLED } from "@/hooks/useLocalDeployGate";
import type { ServerInfo } from "@/lib/api/system";

/** The wizard's server row, shared by connected and managed destinations. */
export function ServerRowContent({ server, active = false }: { server: ServerInfo; active?: boolean }) {
  const { t } = useI18n();
  const { deployMode } = usePlatform();
  const localComingSoon = server.isLocal && deployMode === "desktop" && !DESKTOP_LOCAL_DEPLOY_ENABLED;
  const managed = server.managed;
  const copy = t.billing.workspaces;
  return (
    <>
      <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${active ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
        <Icon name="server" className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-start">
        <span className="truncate text-sm font-medium text-foreground">
          {server.name || server.sshHost || server.id}
          {server.isLocal && <span className="ms-2 rounded bg-info/10 px-1.5 py-0.5 text-xs text-info">{t.deploy.targetStep.thisServerBadge}</span>}
        </span>
        <span className="truncate text-xs font-normal text-muted-foreground">
          {managed ? (
            <>
              {interpolate(managed.projectCount === 1 ? copy.oneProject : copy.projectCount, { count: String(managed.projectCount) })}
              {managed.resources ? <>{" · "}<bdi dir="ltr">{formatCpuCores(managed.resources.cpuCores)} · {formatMemoryMb(managed.resources.memoryMb)} {t.deploy.power.ram}</bdi></>
                : managed.state === "needs_plan" ? ` · ${copy.states.needs_plan}` : ""}
            </>
          ) : localComingSoon ? "Running here is coming soon — connect a server"
            : server.isLocal ? t.deploy.targetStep.thisServerHost
              : <bdi dir="ltr">{server.sshUser || "root"}@<BlurIp>{server.sshHost}</BlurIp>:{server.sshPort || 22}</bdi>}
        </span>
      </span>
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
}

/** Existing wizard picker, using the shared menu's positioning and keyboard handling. */
export function ServerPicker<T extends ServerInfo>({
  servers, selectedId, onSelect, onAddServer, addServerLabel, label, showLabel = true, disabled,
}: ServerPickerProps<T>) {
  const { t } = useI18n();
  const copy = t.deploy.targetStep;
  const name = label ?? copy.chooseServer;
  return (
    <div className="space-y-2">
      {showLabel && <p className="text-sm font-medium text-muted-foreground">{name}</p>}
      <CustomSelect
        aria-label={name}
        value={selectedId ?? ""}
        disabled={disabled}
        placeholder={copy.chooseServer}
        triggerClassName="rounded-lg border-0 bg-muted/40 px-3 py-2.5 text-start hover:bg-muted/60"
        options={servers.map(server => ({
          value: server.id,
          label: server.name || server.sshHost || server.id,
          description: server.managed ? undefined : `${server.sshUser || "root"}@${server.sshHost}:${server.sshPort || 22}`,
        }))}
        renderOption={(option, selected) => <ServerRowContent server={servers.find(server => server.id === option.value)!} active={selected} />}
        onChange={id => {
          const server = servers.find(server => server.id === id);
          if (server) onSelect(server);
        }}
        searchable
        searchPlaceholder={copy.searchPlaceholder}
        emptySearchMessage={() => copy.noServersMatch}
        footerAction={onAddServer ? {
          label: addServerLabel ?? copy.addServer,
          icon: <Icon name="plus" className="size-4" />,
          onClick: onAddServer,
        } : undefined}
      />
    </div>
  );
}
