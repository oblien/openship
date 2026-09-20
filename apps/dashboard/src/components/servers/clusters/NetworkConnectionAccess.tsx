"use client";

import { ArrowRight } from "lucide-react";
import { setNetworkConnection, type NetworkAccessPolicy } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";
import type { NetworkTopologyLink } from "./network-topology";

/** Shared by the initial draft and prepared setup. Saving/replanning belongs to the route. */
export function NetworkConnectionAccess({
  link,
  memberIds,
  access,
  onChange,
  disabled = false,
}: {
  link: NetworkTopologyLink;
  memberIds: string[];
  access?: NetworkAccessPolicy;
  onChange(access: NetworkAccessPolicy): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const a = t.servers.networks.access;
  return (
    <fieldset disabled={disabled} aria-label={a.title} className="mt-5 space-y-3">
      <p className="text-sm text-muted-foreground">{a.description}</p>
      <div className="grid gap-3 @2xl/network-diagnostics:grid-cols-2">
        {link.directions.map(({ source, target, allowed }, index) => (
          <label
            key={source.serverId}
            className="flex cursor-pointer items-start gap-3 rounded-xl bg-muted/30 p-4 text-sm"
          >
            <Checkbox
              checked={allowed}
              aria-label={`${source.name} → ${target.name}`}
              className="mt-0.5"
              onCheckedChange={(checked) => {
                const forward = index === 0 ? checked : link.directions[0]!.allowed;
                const reverse = index === 1 ? checked : link.directions[1]!.allowed;
                onChange(
                  setNetworkConnection(
                    access,
                    memberIds,
                    link.source.serverId,
                    link.target.serverId,
                    forward ? (reverse ? "both" : "forward") : reverse ? "reverse" : "blocked",
                  ),
                );
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                <NetworkDiagnosticText value={source.name} />
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                <NetworkDiagnosticText value={target.name} />
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {allowed ? a.allPorts : a.blocked}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
