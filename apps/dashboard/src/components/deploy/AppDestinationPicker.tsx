"use client";

import React from "react";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import type { DeployTarget } from "@/context/deployment/types";

export interface AppDestination {
  /**
   * A destination is a BINDING, so never "local" — that one is what a project with
   * no server and no cloud workspace DERIVES at deploy time, and this picker has no
   * card for it (see below). Excluded rather than merely unused, so an install body
   * can't carry a value the API now rejects.
   */
  deployTarget: Exclude<DeployTarget, "cloud" | "local">;
  serverId?: string;
  /** Host of the selected server (sshHost) — lets the app wizard build a
   *  reachable `http://host:port` URL for a port-only (no-domain) install. */
  serverHost?: string;
  /** Display name of the selected server, so a summary can name the destination
   *  the operator recognises instead of re-fetching the server row for it. */
  serverName?: string;
}

/**
 * "Where to install" picker for the app wizards. Destination is a SERVER ROW
 * (the shared mail-style `ServerSelector` dropdown — pre-selects the first/only
 * server so the wizard opens with a destination already chosen, collapses many
 * into a searchable list, carries its own "add server"). Reports the pick as
 * `{deployTarget, serverId, serverHost}`.
 *
 * THE OPENSHIP HOST IS A SERVER ROW, never a separate "this machine" card. On a
 * server-host install the box registers itself as the `isLocal` "This Server" row
 * (startup/self-server.ts) and appears in the selector above, so a second card for
 * the same machine was not just redundant — it resolved to the same platform
 * (`resolveTargetPlatform` builds an identical selfhosted/socket/`provision:local`
 * target either way) while losing the server's `sshHost`, which is what makes a
 * port-only install's URL reachable. Picking it on a VPS yielded
 * `http://localhost:<port>`, useless from anywhere but the box itself.
 *
 * That rule is now unconditional, which also makes this agree with the MAIN deploy
 * wizard — `useDesktopTargets` offers servers + cloud and no local card, on every
 * mode including desktop. Two pickers for the same question should not disagree
 * about what a destination is.
 */
export function AppDestinationPicker({
  value,
  onChange,
}: {
  value: AppDestination | null;
  onChange: (d: AppDestination) => void;
}) {
  const serverActive = value?.deployTarget === "server";

  return (
    <div className="space-y-2">
      <div
        className={`rounded-xl transition-shadow ${serverActive ? "ring-2 ring-primary/40" : ""}`}
      >
        <ServerSelector
          compact
          autoSelectFirst
          value={serverActive ? (value?.serverId ?? null) : null}
          onSelect={(s: ServerOption | null) => {
            if (s)
              onChange({
                deployTarget: "server",
                serverId: s.id,
                serverHost: s.host,
                serverName: s.name,
              });
          }}
        />
      </div>
    </div>
  );
}
