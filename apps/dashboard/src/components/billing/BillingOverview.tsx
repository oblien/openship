"use client";

import React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  FolderKanban,
  Rocket,
  Globe,
  Users,
  Clock,
  HardDrive,
} from "lucide-react";
import { PLANS, type PlanId } from "@repo/core";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface BillingData {
  planId: PlanId;
  interval: "monthly" | "annual";
  status: "active" | "canceled" | "past_due" | "none";
  currentPeriodEnd?: string;
  usage: {
    projects: number;
    deploymentsThisMonth: number;
    customDomains: number;
    teamMembers: number;
    buildMinutes: number;
    bandwidthGb: number;
  };
}

interface BillingOverviewProps {
  data: BillingData;
  upgradeHref?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatLimit(value: number) {
  return value.toLocaleString();
}

function usagePercent(used: number, limit: number) {
  if (limit === 0) return 100;
  return Math.min(Math.round((used / limit) * 100), 100);
}

function ringStroke(pct: number): string {
  if (pct >= 90) return "stroke-red-500";
  if (pct >= 75) return "stroke-amber-500";
  return "stroke-primary";
}

/* ── SVG circular gauge ──────────────────────────────────────────── */

const RING_SIZE = 64;
const RING_STROKE = 5;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R; // circumference

function UsageRing({ pct, icon }: { pct: number; icon: React.ReactNode }) {
  const offset = RING_C - (RING_C * Math.min(pct, 100)) / 100;
  return (
    <div className="relative flex items-center justify-center" style={{ width: RING_SIZE, height: RING_SIZE }}>
      <svg width={RING_SIZE} height={RING_SIZE} className="-rotate-90">
        {/* track */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_R}
          fill="none"
          className="stroke-muted"
          strokeWidth={RING_STROKE}
        />
        {/* value */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_R}
          fill="none"
          className={`${ringStroke(pct)} transition-all duration-500`}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="absolute text-muted-foreground">{icon}</span>
    </div>
  );
}

/* ── Upgrade button with gradient edge glow ──────────────────────── */

export function UpgradeButton({ children, onClick, className = "" }: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all ${className}`}
    >
      {/* glow layer */}
      <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
      {/* solid bg */}
      <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
      <span className="relative flex items-center gap-1.5">{children}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export const BillingOverview: React.FC<BillingOverviewProps> = ({ data, upgradeHref }) => {
  const plan = PLANS[data.planId];

  const usageRows = [
    { label: "Projects",     icon: <FolderKanban className="size-4" />, used: data.usage.projects,              limit: plan.projects },
    { label: "Deployments",  icon: <Rocket className="size-4" />,       used: data.usage.deploymentsThisMonth,  limit: plan.deploymentsPerMonth },
    { label: "Domains",      icon: <Globe className="size-4" />,        used: data.usage.customDomains,         limit: plan.customDomains },
    { label: "Team",         icon: <Users className="size-4" />,        used: data.usage.teamMembers,           limit: plan.teamMembers },
    { label: "Build min.",   icon: <Clock className="size-4" />,        used: data.usage.buildMinutes,          limit: plan.buildMinutes },
    { label: "Bandwidth",    icon: <HardDrive className="size-4" />,    used: data.usage.bandwidthGb,           limit: plan.bandwidth, suffix: "GB" },
  ];

  const needsUpgrade = usageRows.some(
    (r) => r.used >= r.limit * 0.9,
  );

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Current Usage</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Track usage against your {plan.name.toLowerCase()} plan limits.
          </p>
        </div>
        {needsUpgrade && data.planId !== "team" && upgradeHref && (
          <Link
            href={upgradeHref}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Review plans
            <ArrowUpRight className="size-3.5" />
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
        {usageRows.map((row) => {
          const pct = usagePercent(row.used, row.limit);
          return (
            <div key={row.label} className="flex flex-col items-center gap-2">
              <UsageRing pct={pct} icon={row.icon} />
              <div className="text-center">
                <p className="text-[13px] font-semibold tabular-nums text-foreground">
                  {row.used.toLocaleString()}{row.suffix ? ` ${row.suffix}` : ""}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  of {formatLimit(row.limit)}{row.suffix ? ` ${row.suffix}` : ""}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground/70">{row.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {needsUpgrade && data.planId !== "team" && upgradeHref && (
        <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <p className="text-sm text-amber-700 dark:text-amber-400">
            You&apos;re approaching your plan limits. <Link href={upgradeHref} className="font-medium underline underline-offset-2 hover:no-underline">Upgrade now</Link> for more capacity.
          </p>
        </div>
      )}
    </div>
  );
};
