"use client";

import ServerSelector from "@/components/shared/ServerSelector";
import type { DeployTarget } from "@/context/deployment/types";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";

export interface AppDestination {
  /**
   * A destination is a BINDING, so never "local" — that one is what a project with
   * no server and no cloud workspace DERIVES at deploy time, and this picker has no
   * card for it (see below). Excluded rather than merely unused, so an install body
   * can't carry a value the API now rejects.
   */
  deployTarget: Exclude<DeployTarget, "local" | "cluster">;
  serverId?: string;
  workspaceId?: string;
  /** Host of the selected server (sshHost) — lets the app wizard build a
   *  reachable `http://host:port` URL for a port-only (no-domain) install. */
  serverHost?: string;
  /** Display name of the selected server, so a summary can name the destination
   *  the operator recognises instead of re-fetching the server row for it. */
  serverName?: string;
}

/** Catalog apps use the same acquired/connected server destinations as source projects. */
export function AppDestinationPicker({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  disabledReason,
  onReadyChange,
}: {
  value: AppDestination | null;
  onChange: (d: AppDestination) => void;
  disabled?: boolean;
  readOnly?: boolean;
  disabledReason?: string;
  onReadyChange?: (ready: boolean) => void;
}) {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  return (
    <ServerSelector
      value={value?.serverId}
      disabled={disabled}
      readOnly={readOnly}
      selectedName={value?.serverName}
      disabledReason={disabledReason}
      onReadyChange={onReadyChange}
      label={t.billing.workspaces.destination}
      forDeployment
      autoSelectFirst
      useSavedDefault
      compact
      onSelect={(server) => {
        if (!server && selfHosted) return;
        onChange({
          deployTarget: server?.raw.managed || !selfHosted ? "cloud" : "server",
          serverId: server?.id,
          workspaceId: server?.raw.managed?.id,
          serverHost: server?.host,
          serverName: server?.name,
        });
      }}
    />
  );
}
