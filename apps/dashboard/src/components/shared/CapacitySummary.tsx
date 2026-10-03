"use client";

import type { CloudAllocation } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { formatBillingNumber } from "@/lib/billing-usage";

/** The same capacity facts in plan cards and their provisioned workspaces. */
export function CapacitySummary({ resources }: { resources: CloudAllocation }) {
  const { t, locale } = useI18n();
  const number = (value: number) => formatBillingNumber(value, locale);
  const memory = (mb: number) => (mb >= 1024 ? `${number(mb / 1024)} GB` : `${number(mb)} MB`);

  return (
    <dl className="grid grid-cols-3 gap-2 rounded-xl bg-muted/40 p-3">
      {[
        { label: t.billing.header.vcpus, value: number(resources.cpuCores) },
        { label: t.billing.header.ram, value: memory(resources.memoryMb) },
        { label: t.billing.resourcesGuide.storage, value: memory(resources.diskMb) },
      ].map(({ label, value }) => (
        <div key={label} className="flex min-w-0 flex-col">
          <dt className="order-last mt-1 text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm font-medium tabular-nums text-foreground">
            <bdi>{value}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}
