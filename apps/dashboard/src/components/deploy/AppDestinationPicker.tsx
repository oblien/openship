"use client";

import React from "react";
import { Cloud, Cpu } from "lucide-react";
import { OptionCard } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import type { DeployTarget } from "@/context/deployment/types";
import { useI18n } from "@/components/i18n-provider";
import { useCloud } from "@/context/CloudContext";

export interface AppDestination {
  deployTarget: DeployTarget;
  serverId?: string;
  /** Host of the selected server (sshHost) — lets the app wizard build a
   *  reachable `http://host:port` URL for a port-only (no-domain) install. */
  serverHost?: string;
}

/**
 * "Where to install" picker for the app wizards. Servers use the shared
 * mail-style `ServerSelector` dropdown (pre-selects the first/only server so the
 * wizard opens with a destination already chosen; collapses many into a
 * searchable list, carries its own "add server"), with Openship Cloud /
 * this-machine as sibling choices. Reports the pick as
 * `{deployTarget, serverId, serverHost}`.
 */
export function AppDestinationPicker({
  value,
  onChange,
  allowLocal = false,
}: {
  value: AppDestination | null;
  onChange: (d: AppDestination) => void;
  allowLocal?: boolean;
}) {
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  const opt = t.deploy.targetStep.options;
  const { connected: cloudConnected } = useCloud();

  const serverActive = value?.deployTarget === "server";

  return (
    <div className="space-y-2">
      {/* Servers — mail-style dropdown. Ring shows when it's the active target
          (the selector only highlights a server while server is chosen). */}
      <div
        className={`rounded-xl transition-shadow ${serverActive ? "ring-2 ring-primary/40" : ""}`}
      >
        <ServerSelector
          compact
          autoSelectFirst
          value={serverActive ? (value?.serverId ?? null) : null}
          onSelect={(s: ServerOption | null) => {
            if (s) onChange({ deployTarget: "server", serverId: s.id, serverHost: s.host });
          }}
        />
      </div>

      <OptionCard
        value="cloud"
        selected={value?.deployTarget === "cloud"}
        onSelect={() => onChange({ deployTarget: "cloud" })}
        icon={<Cloud className="size-4" />}
        label={opt.cloud}
        description={cloudConnected ? opt.cloudConnectedDesc : opt.cloudDisconnectedDesc}
      />

      {allowLocal && (
        <OptionCard
          value="local"
          selected={value?.deployTarget === "local"}
          onSelect={() => onChange({ deployTarget: "local" })}
          icon={<Cpu className="size-4" />}
          label={w.destLocal}
          description={w.destLocalDesc}
        />
      )}
    </div>
  );
}
