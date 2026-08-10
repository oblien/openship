"use client";

import React from "react";
import { Cloud, Cpu } from "lucide-react";
import { OptionCard } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import type { DeployTarget } from "@/context/deployment/types";
import { useI18n } from "@/components/i18n-provider";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";

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
 * searchable list, carries its own "add server"), with Openship Cloud as a
 * sibling choice. Reports the pick as `{deployTarget, serverId, serverHost}`.
 *
 * The selector is a PEER radio option here, not a fixed header: passing an
 * explicit `null` while cloud/local is active is what makes it render unselected
 * and clickable again, so the choice stays two-way on a one-server box.
 *
 * DESKTOP ONLY gets a separate "this machine" card. On a server-host install the
 * Openship host is already registered as the `isLocal` "This Server" row (see
 * startup/self-server.ts) and appears in the selector above, so a second card for
 * the same box is not just redundant — it resolves to the same platform
 * (`resolveTargetPlatform` builds an identical selfhosted/socket/`provision:local`
 * target either way) while losing the server's `sshHost`, which is what makes a
 * port-only install's URL reachable. Picking it on a VPS yielded
 * `http://localhost:<port>`, useless from anywhere but the box itself. The main
 * deploy wizard already models the host purely as a server row (`useDesktopTargets`
 * offers servers + cloud, no local), so this keeps the two consistent.
 *
 * The same rule covers a host-control-disabled box: no `isLocal` row is created
 * there because the host is deliberately not a deploy target, and it isn't
 * desktop, so no local card either.
 */
export function AppDestinationPicker({
  value,
  onChange,
}: {
  value: AppDestination | null;
  onChange: (d: AppDestination) => void;
}) {
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  const opt = t.deploy.targetStep.options;
  const { connected: cloudConnected } = useCloud();
  const { deployMode } = usePlatform();

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

      {deployMode === "desktop" && (
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
