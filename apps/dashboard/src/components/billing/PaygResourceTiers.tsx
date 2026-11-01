"use client";

import { useId } from "react";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Tabs } from "@/components/ui/Tabs";
import type { PaygTier } from "@/lib/prepaid-estimate";

/** Tier selection describes a prospective pool; it never grants paid access. */
export function PaygResourceTiers({
  tiers,
  selected,
  onChange,
  money,
}: {
  tiers: PaygTier[];
  selected: PaygTier;
  onChange: (id: string) => void;
  money: (cents: number) => string;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.purchase.tiers;
  const id = useId();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const name = (tier: PaygTier) => interpolate(copy.name, { level: number(tier.level) });
  const fields = [
    { key: "cpuCores", label: t.billing.custom.cpu, divisor: 1, unit: "vCPU" },
    { key: "memoryMb", label: t.billing.custom.memory, divisor: 1024, unit: "GiB" },
    { key: "diskGb", label: t.billing.custom.disk, divisor: 1, unit: "GiB" },
    { key: "servers", label: copy.servers, divisor: 1, unit: "" },
  ] as const;

  return (
    <section aria-label={copy.label} className="@container/tier min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-medium">{copy.label}</h4>
        <Tabs
          tabs={tiers.map((tier) => ({ key: tier.id, label: name(tier) }))}
          value={selected.id}
          onChange={onChange}
          idPrefix={id}
          ariaLabel={copy.label}
          size="sm"
          className="border-b-0"
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {interpolate(copy.unlock, { amount: money(selected.minimumFundingCents) })}
      </p>
      {tiers.map((tier) => (
        <div
          key={tier.id}
          id={`${id}-panel-${tier.id}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${tier.id}`}
          hidden={tier.id !== selected.id}
        >
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 rounded-xl bg-muted/40 p-3.5 @min-[25rem]/tier:grid-cols-4">
            {fields.map(({ key, label, divisor, unit }) => (
              <div key={key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-sm font-semibold tabular-nums">
                  <bdi dir="ltr">
                    {number(tier.pool[key] / divisor)}
                    {unit && ` ${unit}`}
                  </bdi>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="mt-2 text-xs text-muted-foreground">{copy.hint}</p>
    </section>
  );
}
