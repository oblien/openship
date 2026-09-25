"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { billingApi, type BillingResources, type BillingState } from "@/lib/api/billing";
import { ResourceMeter } from "./ResourceMeter";

export function BillingResourceUsage({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourceOverview;
  const [data, setData] = useState<BillingResources | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const noPlan = state.tier === "free";
  useEffect(() => {
    let active = true;
    setData(null);
    setFailed(false);
    if (noPlan) { setLoading(false); return; }
    setLoading(true);
    billingApi.getResources().then(value => {
      if (active) {
        setData(value);
        setFailed(value.compute.status !== "available" || value.edge.status !== "available");
      }
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [noPlan, state.tier, state.currentPeriod.start, state.currentPeriod.end, attempt]);
  const compute = data?.compute;
  const edge = data?.edge;
  const periodLabel = (period?: { start: string; end: string }) => period ? interpolate(copy.period, {
    start: new Date(period.start).toLocaleDateString(locale, { month: "short", day: "numeric" }),
    end: new Date(period.end).toLocaleDateString(locale, { month: "short", day: "numeric" }),
  }) : copy.currentPeriod;
  const measured = loading ? t.billing.usage.breakdown.loading : failed ? copy.unavailable : copy.measuredUsage;
  const computeRows = [
    { label: copy.cpu, hint: copy.cpuHint, used: compute?.cpuHours ?? null, unit: "vCPU-h", Icon: "cpu" as const },
    { label: copy.memory, hint: copy.memoryHint, used: compute?.memoryGbHours ?? null, unit: "GB-h", Icon: "memory" as const },
    { label: copy.disk, hint: copy.diskHint, used: compute?.diskIoGb ?? null, unit: "GB", Icon: "hard-drive" as const },
    { label: copy.transfer, hint: copy.transferHint, used: compute?.networkGb ?? null, unit: "GB", Icon: "arrows-up-down" as const },
  ];

  return <section className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6" aria-busy={loading}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold tracking-tight">{copy.computeTitle}</h2>
        <p className="mt-1.5 text-xs text-muted-foreground">{noPlan ? t.billing.onboarding.planRequired : periodLabel(compute?.period)}</p></div>
      {!noPlan && <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}
        aria-label={copy.refresh} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
        <UiIcon name="refresh" className={`size-4 ${loading ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
      </button>}
    </div>
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{copy.computeHint}</p>
    {!noPlan && failed && <p role="status" className="mt-3 text-xs text-warning">{copy.partialError}</p>}
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {computeRows.map(({ Icon, ...row }) => <ResourceMeter key={row.label} {...row} noPlan={noPlan}
        footnote={compute?.status === "available" ? copy.sharedCompute : measured} icon={<UiIcon name={Icon} className="size-4" aria-hidden="true" />} />)}
    </div>

    <div className="mb-4 mt-6 flex flex-wrap items-baseline justify-between gap-2 border-t border-border/40 pt-5">
      <h3 className="text-sm font-semibold">{copy.edgeTitle}</h3>
      <p className="text-xs text-muted-foreground">{noPlan ? t.billing.onboarding.planRequired : periodLabel(edge?.period)}</p>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ResourceMeter label={copy.bandwidth} hint={copy.bandwidthHint} noPlan={noPlan} used={edge?.bandwidthGb ?? null}
        max={(edge ? edge.limits.bandwidthGb : state.plan?.edge?.bandwidthGb) ?? undefined} unit="GB" icon={<UiIcon name="globe" className="size-4" aria-hidden="true" />}
        {...(edge?.status !== "available" ? { footnote: measured } : {})} />
      <ResourceMeter label={copy.requests} hint={copy.requestsHint} noPlan={noPlan} used={edge?.requests ?? null}
        footnote={edge?.status === "available" ? copy.requestsIncluded : measured} icon={<UiIcon name="bolt" className="size-4" aria-hidden="true" />} />
    </div>
    {!noPlan && <Link href="/billing/usage" className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium text-foreground hover:underline">
      {copy.viewUsage}<UiIcon name="arrow-up-right" className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
    </Link>}
  </section>;
}
