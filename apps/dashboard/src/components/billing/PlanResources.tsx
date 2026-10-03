"use client";

import { planServiceResources, formatCpuCores, formatMemoryMb } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { formatBillingNumber } from "@/lib/billing-usage";
import type { ApiPlan } from "./PricingCards";
import { planCapacity } from "./plan-presentation";
import { CapacitySummary } from "@/components/shared/CapacitySummary";

/** Shared by plan comparisons and the compact subscription summary. */
export function PlanCapacity({ plan, workspaceScoped = false }: { plan: ApiPlan; workspaceScoped?: boolean }) {
  const { t } = useI18n();
  const capacity = planCapacity(plan);
  if (!capacity) return null;
  return (
    <div className="space-y-2">
      {workspaceScoped && <p className="text-xs text-muted-foreground">{t.billing.workspaces.provisioned}</p>}
      <CapacitySummary resources={{ cpuCores: capacity.cpu, memoryMb: capacity.memoryGb * 1024, diskMb: capacity.diskGb * 1024 }} />
    </div>
  );
}

/** Compare concrete resources. Metering is explained once after the plans. */
export function PlanResources({ plan, compact = false, workspaceScoped = false }: { plan: ApiPlan; compact?: boolean; workspaceScoped?: boolean }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  if (plan.id === "free")
    return <p className="text-xs leading-relaxed text-muted-foreground">{copy.setupHint}</p>;
  const count = (n: number | null) =>
    n === null ? copy.unlimited : formatBillingNumber(n, locale);
  const spec = planServiceResources(plan.limits);
  const buildMinutes = plan.limits.buildMinutesPerMonth;
  const facts = [
    { label: copy.projects, value: count(plan.limits.maxProjects) },
    { label: t.billing.capacity.runningServices, value: count(plan.limits.runningServices) },
    {
      label: copy.buildTime,
      value:
        buildMinutes === null
          ? copy.buildIncluded
          : buildMinutes === 0
            ? copy.notIncluded
            : interpolate(copy.buildMinutes, { amount: count(buildMinutes) }),
    },
    {
      label: copy.perService,
      value: spec
        ? `${formatCpuCores(spec.cpuCores)} · ${formatMemoryMb(spec.memoryMb)}`
        : copy.unlimited,
    },
    { label: t.billing.capacity.routes, value: count(plan.limits.freeSubdomains) },
    ...(plan.edge
      ? [
          {
            label: t.billing.resourceOverview.bandwidth,
            value:
              plan.edge.bandwidthGb === null
                ? copy.unlimited
                : interpolate(t.billing.resourceOverview.bandwidthPerMonth, {
                    amount: count(plan.edge.bandwidthGb),
                  }),
          },
        ]
      : []),
  ];

  if (compact)
    return (
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {facts.slice(0, 3).map(({ label, value }) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-3 sm:block"
          >
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium tabular-nums text-foreground sm:mt-2">
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    );

  return (
    <div className="space-y-4 py-4">
      <PlanCapacity plan={plan} workspaceScoped={workspaceScoped} />
      <dl className="space-y-2.5">
        {facts.map(({ label, value }) => (
          <div key={label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="max-w-40 text-end text-sm font-medium tabular-nums text-foreground">
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
