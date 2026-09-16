"use client";

import { useId } from "react";
import type { ClusterCapabilities } from "@repo/contracts";
import type { InfrastructureProviderId } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Label } from "@/components/ui/label";
import { InfrastructureProviderLogo } from "./InfrastructureProviderLogo";

export function InfrastructureProviderSelect({
  providers,
  value,
  onChange,
  disabled,
}: {
  providers: ClusterCapabilities["providers"];
  value: InfrastructureProviderId;
  onChange(value: InfrastructureProviderId): void;
  disabled?: boolean;
}) {
  const id = useId();
  const { t } = useI18n();
  const c = t.servers.clusters;

  return (
    <div className="min-w-0">
      <Label htmlFor={id} className="block text-muted-foreground">
        {c.provider}
      </Label>
      <CustomSelect
        id={id}
        aria-label={c.provider}
        variant="filled"
        className="mt-1.5"
        value={value}
        onChange={onChange}
        disabled={disabled}
        searchable
        searchPlaceholder={c.searchProviders}
        emptyMessage={c.noProvidersFound}
        options={providers.map((provider) => ({
          value: provider.id,
          label: provider.id === "custom" ? c.customProvider : provider.name,
          description: provider.network,
          icon: <InfrastructureProviderLogo providerId={provider.id} />,
        }))}
      />
    </div>
  );
}
