"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useEffect, useState } from "react";
import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { billingApi, type BillingResources, type BillingState } from "@/lib/api/billing";
import { Button } from "@/components/ui/button";
import { ResourceMeter } from "./ResourceMeter";
import { isNewCloudCustomer } from "@/lib/billing-presentation";

export function BillingResourceUsage({ state }: { state: BillingState }) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourceOverview;
  const [data, setData] = useState<BillingResources | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const newCustomer = isNewCloudCustomer(state);
  useEffect(() => {
    let active = true;
    setData(null);
    setFailed(false);
    if (newCustomer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    billingApi
      .getResources(state.workspace?.id)
      .then((value) => {
        if (active) {
          setData(value);
          setFailed(value.compute.status !== "available" || value.edge.status !== "available");
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    state.workspace?.id,
    newCustomer,
    state.tier,
    state.currentPeriod.start,
    state.currentPeriod.end,
    attempt,
  ]);
  if (newCustomer) return null;
  const compute = data?.compute;
  const edge = data?.edge;
  const periodLabel = (period?: { start: string; end: string }) =>
    period
      ? interpolate(copy.period, {
          start: new Date(period.start).toLocaleDateString(locale, {
            month: "short",
            day: "numeric",
          }),
          end: new Date(period.end).toLocaleDateString(locale, { month: "short", day: "numeric" }),
        })
      : copy.currentPeriod;
  const computeRows = [
    {
      label: copy.cpu,
      hint: copy.cpuHint,
      used: compute?.cpuHours ?? null,
      unit: "vCPU-h",
      Icon: "cpu" as const,
    },
    {
      label: copy.memory,
      hint: copy.memoryHint,
      used: compute?.memoryGbHours ?? null,
      unit: "GB-h",
      Icon: "memory" as const,
    },
    {
      label: copy.disk,
      hint: copy.diskHint,
      used: compute?.diskIoGb ?? null,
      unit: "GB",
      Icon: "hard-drive" as const,
    },
    {
      label: copy.transfer,
      hint: copy.transferHint,
      used: compute?.networkGb ?? null,
      unit: "GB",
      Icon: "arrows-up-down" as const,
    },
  ];

  return (
    <section className="@container/usage rounded-2xl bg-card p-5" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{copy.computeTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{periodLabel(compute?.period)}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href="/billing/usage">
              {copy.viewUsage}
              <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={loading}
            onClick={() => setAttempt((value) => value + 1)}
            aria-label={copy.refresh}
          >
            <UiIcon
              name="refresh"
              className={`size-4 ${loading ? "motion-safe:animate-spin" : ""}`}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
      {failed && (
        <p role="status" className="mt-3 text-sm text-warning">
          {copy.partialError}
        </p>
      )}
      <div className="mt-4 grid grid-cols-1 gap-3 @min-[28rem]/usage:grid-cols-2">
        {computeRows.map(({ Icon, ...row }) => (
          <ResourceMeter
            key={row.label}
            {...row}
            loading={loading}
            footnote={compute?.status === "available" ? undefined : copy.unavailable}
            icon={<UiIcon name={Icon} className="size-4" aria-hidden="true" />}
          />
        ))}
      </div>
      <div className="mb-3 mt-5 flex flex-wrap items-baseline justify-between gap-2 border-t border-border/40 pt-4">
        <h3 className="text-sm font-medium text-foreground">{copy.edgeTitle}</h3>
        <p className="text-xs text-muted-foreground">{periodLabel(edge?.period)}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 @min-[28rem]/usage:grid-cols-2">
        <ResourceMeter
          label={copy.bandwidth}
          hint={copy.bandwidthHint}
          loading={loading}
          used={edge?.bandwidthGb ?? null}
          max={edge ? edge.limits.bandwidthGb : state.plan?.edge?.bandwidthGb}
          unit="GB"
          icon={<UiIcon name="globe" className="size-4" aria-hidden="true" />}
          footnote={edge?.status === "available" ? undefined : copy.unavailable}
        />
        <ResourceMeter
          label={copy.requests}
          hint={copy.requestsHint}
          loading={loading}
          used={edge?.requests ?? null}
          footnote={edge?.status === "available" ? copy.requestsIncluded : copy.unavailable}
          icon={<UiIcon name="bolt" className="size-4" aria-hidden="true" />}
        />
      </div>
    </section>
  );
}
