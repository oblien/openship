"use client";

import { Network, ShieldCheck } from "lucide-react";
import { INFRASTRUCTURE_PROVIDERS, nativeNetworkSource } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { InfrastructureProviderLogo } from "@/components/servers/InfrastructureProviderLogo";

/** The network's source, rather than a list of its servers' hosting providers. */
export function NetworkSource({
  cluster,
  showIcon = true,
}: {
  cluster: Parameters<typeof nativeNetworkSource>[0];
  showIcon?: boolean;
}) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const source = nativeNetworkSource(cluster);
  const managed = cluster.network.mode === "wireguard";
  const provider = INFRASTRUCTURE_PROVIDERS.find((entry) => entry.id === source.providerId);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-xs text-muted-foreground">
      {showIcon &&
        (managed ? (
          <ShieldCheck className="size-4 shrink-0 text-primary" />
        ) : source.providerId === "custom" ? (
          <Network className="size-4 shrink-0" />
        ) : (
          <InfrastructureProviderLogo providerId={source.providerId} />
        ))}
      <span className="truncate">
        {managed
          ? c.managed.title
          : source.providerId === "custom"
            ? c.networkSetup.customNetwork
            : provider?.name}
        {!managed && source.networkRef && (
          <span className="text-foreground"> · {source.networkRef}</span>
        )}
      </span>
    </span>
  );
}
