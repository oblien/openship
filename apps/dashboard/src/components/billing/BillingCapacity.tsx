"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { PLANS, RESOURCE_TIER_SPECS, formatCpuCores, formatMemoryMb } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import { formatBillingNumber, formatMilliCredits } from "@/lib/billing-usage";
import { cloudUsagePercent, hasUnlimitedCloudCredits } from "@/lib/billing-presentation";
import { ResourceLabel as MetricLabel, ResourceMeter, ResourceRing } from "./ResourceMeter";

export type { BillingState };

/** Projects, services and build time are the product. Credits remain accounting details. */
export function BillingCapacity({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  const onboarding = t.billing.onboarding;
  const limits = state.plan?.limits ?? PLANS[state.tier].limits;
  const cap = state.capacity;
  const noPlan = state.tier === "free";
  const number = (value: number) => formatBillingNumber(value, locale);
  const spec = state.maxServiceMachine === undefined
    ? (limits.maxResourceTier ? RESOURCE_TIER_SPECS[limits.maxResourceTier] : null) : state.maxServiceMachine;
  const rows = [
    { label: copy.projects, hint: copy.projectsHint, meter: cap?.projects ?? { used: null, max: limits.maxProjects }, Icon: "folder-open" as const },
    { label: copy.apps, hint: copy.appsHint, meter: cap?.services ?? { used: null, max: limits.runningServices }, Icon: "layers" as const },
    { label: copy.buildTime, hint: copy.buildHint, meter: cap?.buildMinutes ?? { used: state.buildTimeMinutes, max: limits.buildMinutesPerMonth }, unit: t.billing.header.min, Icon: "clock" as const },
    { label: t.billing.capacity.routes, hint: copy.routesHint, meter: cap?.routes ?? { used: null, max: limits.freeSubdomains }, Icon: "globe" as const },
  ];
  const percent = cloudUsagePercent(state);
  const unlimited = hasUnlimitedCloudCredits(state);
  const resetAt = state.buildMinutesResetAt ? new Date(state.buildMinutesResetAt) : null;
  const savedProjects = cap?.projects?.used ?? 0;

  return <section className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{noPlan ? copy.noPlan : copy.includedTitle}</h2>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{noPlan ? onboarding.workspaceDescription : t.billing.resourceOverview.overviewHint}</p>
      </div>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground"><UiIcon name="cloud" className="size-5" aria-hidden="true" /></div>
    </div>
    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {rows.map(({ meter, Icon, ...row }) => <ResourceMeter key={row.label} {...row} {...meter} noPlan={noPlan} icon={<UiIcon name={Icon} className="size-4" aria-hidden="true" />} />)}
    </div>
    {noPlan ? <>
      {savedProjects > 0 && <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{interpolate(onboarding.savedProjects, { count: number(savedProjects) })}</p>}
      {state.balance.quotaRemaining != null && state.balance.quotaRemaining !== 0 && <details className="mt-5 rounded-xl bg-muted/30 p-4">
        <summary className="cursor-pointer text-sm font-medium">{onboarding.savedCredits}</summary>
        <p className="mt-3 text-sm tabular-nums">{formatMilliCredits(state.balance.quotaRemaining, locale)} {t.billing.overview.creditsLeft}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{onboarding.savedCreditsHint}</p>
      </details>}
    </> : <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted/20 px-4 py-3.5">
        <MetricLabel label={copy.machine} hint={copy.machineHint} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium tabular-nums text-foreground">
          <span className="inline-flex items-center gap-2"><UiIcon name="cpu" className="size-4 text-muted-foreground" aria-hidden="true" /><bdi>{spec ? formatCpuCores(spec.cpuCores) : limits.maxResourceTier === null ? copy.unlimited : "—"}</bdi></span>
          <span className="inline-flex items-center gap-2"><UiIcon name="memory" className="size-4 text-muted-foreground" aria-hidden="true" /><bdi>{spec ? formatMemoryMb(spec.memoryMb) : limits.maxResourceTier === null ? copy.unlimited : "—"}</bdi></span>
        </div>
      </div>
      {resetAt && Number.isFinite(resetAt.getTime()) && <p className="mt-3 text-xs text-muted-foreground">{interpolate(copy.reset, {
        date: resetAt.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }),
      })}</p>}
      <div className="mt-6 border-t border-border/40 pt-5">
        <div className="flex items-center gap-5 rounded-xl bg-muted/25 p-4">
          <ResourceRing large label={copy.usageAllowance} used={percent} max={100}>
            <span className="text-xl font-semibold tabular-nums">{percent === null ? "—" : `${number(percent)}%`}</span>
          </ResourceRing>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{copy.usageAllowance}</h3>
            <p className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{unlimited ? copy.unlimited : percent === null ? t.billing.resourceOverview.unavailable
              : interpolate(t.billing.resourceOverview.remaining, { amount: `${number(Math.max(0, 100 - percent))}%` })}</p>
            {percent !== null && <p className="mt-1 text-xs text-muted-foreground">{interpolate(copy.usagePercent, { percent: number(percent) })}</p>}
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.billing.resourceOverview.sharedCompute}</p>
          </div>
        </div>
        <details className="group mt-4 text-xs">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            {copy.usageDetails}<UiIcon name="chevron-down" className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-3 rounded-xl bg-muted/30 p-4 leading-relaxed text-muted-foreground">
            <p className="font-medium tabular-nums text-foreground">{unlimited ? copy.unlimited : `${formatMilliCredits(state.balance.quotaRemaining, locale)} ${t.billing.overview.creditsLeft}`}</p>
            <p className="mt-1 tabular-nums">{t.billing.overview.usedThisPeriod}: {formatMilliCredits(state.balance.quotaUsed, locale)}{state.balance.quotaLimit != null && <> {interpolate(t.billing.capacity.of, { max: formatMilliCredits(state.balance.quotaLimit, locale) })}</>}</p>
            <p className="mt-2">{copy.creditsHint}</p>
            <p className="mt-2">{copy.balanceRule}</p>
          </div>
        </details>
      </div>
    </>}
  </section>;
}

export default BillingCapacity;
