"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { PLANS, planServiceResources, formatCpuCores, formatMemoryMb } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { BillingState } from "@/lib/api/billing";
import { formatBillingNumber, formatMilliCredits } from "@/lib/billing-usage";
import { cloudUsagePercent, hasUnlimitedCloudCredits, isNewCloudCustomer } from "@/lib/billing-presentation";
import { ResourceLabel, ResourceMeter, ResourceRing } from "./ResourceMeter";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ServerUsage } from "@/components/servers/ServerUsage";
import { CloudActivationSteps } from "./CloudActivationSteps";

export type { BillingState };

/** Provider allocations and host measurements remain separate from metered consumption. */
export function BillingCapacity({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  const limits = state.plan?.limits ?? PLANS[state.tier].limits;
  const cap = state.capacity;
  const number = (value: number) => formatBillingNumber(value, locale);
  const serviceCeiling = planServiceResources(limits);
  const spec = state.maxServiceMachine === undefined ? serviceCeiling : state.maxServiceMachine;
  const buildMeter = cap?.buildMinutes ?? {
    used: state.buildTimeMinutes,
    max: limits.buildMinutesPerMonth,
  };
  const rows = [
    {
      label: copy.projects,
      hint: copy.projectsHint,
      meter: cap?.projects ?? { used: null, max: limits.maxProjects },
      Icon: "folder-open" as const,
    },
    {
      label: copy.apps,
      hint: copy.appsHint,
      meter: cap?.services ?? { used: null, max: limits.runningServices },
      Icon: "layers" as const,
    },
    {
      label: copy.buildTime,
      hint: copy.buildHint,
      meter: buildMeter,
      unit: t.billing.header.min,
      Icon: "clock" as const,
      footnote: buildMeter.max === null ? t.billing.resourceOverview.measuredUsage : undefined,
    },
    {
      label: t.billing.capacity.routes,
      hint: copy.routesHint,
      meter: cap?.routes ?? { used: null, max: limits.freeSubdomains },
      Icon: "globe" as const,
    },
  ];
  const percent = cloudUsagePercent(state);
  const unlimited = hasUnlimitedCloudCredits(state);
  const resetAt = state.buildMinutesResetAt ? new Date(state.buildMinutesResetAt) : null;
  const savedProjects = cap?.projects?.used ?? 0;

  // An expired subscription can still have a server and historical usage.
  // Keep those visible without presenting free-tier limits as purchased capacity.
  if (state.tier === "free")
    return (
      <>
        {isNewCloudCustomer(state) ? <CloudActivationSteps /> : state.workspace?.serverId && (
          <ServerUsage key={state.workspace.serverId} serverId={state.workspace.serverId} />
        )}
        {(savedProjects > 0 || (state.balance.quotaRemaining ?? 0) !== 0) && (
          <section className="space-y-3 rounded-2xl bg-card p-5 text-sm text-muted-foreground">
            {savedProjects > 0 && (
              <p>
                {interpolate(t.billing.workspaces.projectCount, { count: number(savedProjects) })}
              </p>
            )}
            {(state.balance.quotaRemaining ?? 0) !== 0 && (
              <>
                <p className="font-medium tabular-nums text-foreground">
                  {(state.balance.quotaRemaining ?? 0) > 0 ? t.billing.onboarding.savedCredits : t.billing.usage.kpi.balance}:{" "}
                  {formatMilliCredits(state.balance.quotaRemaining, locale)}
                </p>
                {(state.balance.quotaRemaining ?? 0) > 0 && <p>{t.billing.onboarding.savedCreditsHint}</p>}
              </>
            )}
          </section>
        )}
      </>
    );

  return (
    <>
      {state.workspace?.serverId && (
        <ServerUsage key={state.workspace.serverId} serverId={state.workspace.serverId} />
      )}
      <section className="@container/capacity rounded-2xl bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">{copy.includedTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.billing.resourceOverview.overviewHint}
            </p>
          </div>
          {state.workspace?.serverId ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={`/servers/${encodeURIComponent(state.workspace.serverId)}`}>
                {t.billing.workspaces.openWorkspace}
              </Link>
            </Button>
          ) : null}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 @min-[28rem]/capacity:grid-cols-2 @min-[48rem]/capacity:grid-cols-3">
          {rows.map(({ meter, Icon, ...row }) => (
            <ResourceMeter
              key={row.label}
              {...row}
              {...meter}
              icon={<UiIcon name={Icon} className="size-4" aria-hidden="true" />}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <ResourceLabel label={copy.machine} hint={copy.machineHint} />
          <p className="font-medium tabular-nums text-foreground">
            <bdi>
              {spec
                ? `${formatCpuCores(spec.cpuCores)} · ${formatMemoryMb(spec.memoryMb)}`
                : serviceCeiling === null
                  ? copy.unlimited
                  : "—"}
            </bdi>
          </p>
        </div>
        {limits.buildMinutesPerMonth !== null && resetAt && Number.isFinite(resetAt.getTime()) && (
          <p className="mt-2 text-xs text-muted-foreground">
            {interpolate(copy.reset, {
              date: resetAt.toLocaleDateString(locale, {
                month: "short",
                day: "numeric",
                year: "numeric",
              }),
            })}
          </p>
        )}
        <details className="group mt-4 rounded-xl bg-muted/35 p-3">
          <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <ResourceRing large label={copy.usageAllowance} used={percent} max={100}>
              <span className="text-sm font-medium tabular-nums">
                {percent === null ? "—" : `${number(percent)}%`}
              </span>
            </ResourceRing>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-foreground">{copy.usageAllowance}</h3>
              <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                {unlimited
                  ? copy.unlimited
                  : percent === null
                    ? t.billing.resourceOverview.unavailable
                    : interpolate(t.billing.resourceOverview.remaining, {
                        amount: `${number(Math.max(0, 100 - percent))}%`,
                      })}
              </p>
            </div>
            <span className="hidden text-xs text-muted-foreground @min-[28rem]/capacity:block">
              {copy.usageDetails}
            </span>
            <UiIcon
              name="chevron-down"
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-3 space-y-2 border-t border-border/40 px-1 pt-3 text-sm text-muted-foreground">
            <p className="font-medium tabular-nums text-foreground">
              {unlimited
                ? copy.unlimited
                : `${formatMilliCredits(state.balance.quotaRemaining, locale)} ${t.billing.overview.creditsLeft}`}
            </p>
            <p className="tabular-nums">
              {t.billing.overview.usedThisPeriod}:{" "}
              {formatMilliCredits(state.balance.quotaUsed, locale)}
              {state.balance.quotaLimit != null && (
                <>
                  {" "}
                  {interpolate(t.billing.capacity.of, {
                    max: formatMilliCredits(state.balance.quotaLimit, locale),
                  })}
                </>
              )}
            </p>
            <p className="text-xs leading-relaxed">{copy.creditUnitsHint}</p>
            <p className="text-xs leading-relaxed">{copy.topupCapacityHint}</p>
          </div>
        </details>
      </section>
    </>
  );
}

export default BillingCapacity;
