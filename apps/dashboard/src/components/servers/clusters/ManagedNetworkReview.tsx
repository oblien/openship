"use client";

import { ChevronDown, Network, ShieldCheck } from "lucide-react";
import type { ManagedNetworkPlan } from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";

/** Shared by creation, membership changes, key rotation and removal approval. */
export function ManagedNetworkReview({ plan }: { plan: ManagedNetworkPlan }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const m = c.managed;
  return (
    <details className="group/network-review rounded-2xl bg-card">
      <summary className="cursor-pointer list-none rounded-2xl p-5 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:px-7 [&::-webkit-details-marker]:hidden">
        <h2 className="flex items-center justify-between gap-3 text-sm font-semibold">
          {m.reviewTitle}
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open/network-review:rotate-180"
          />
        </h2>
      </summary>
      <div className="space-y-5 px-5 pb-5 sm:px-7 sm:pb-7">
        <div className="flex items-start gap-3 rounded-xl bg-muted/40 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="font-semibold">{plan.config.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {m.title} ·{" "}
              {interpolate(c.memberCount, { count: String(plan.config.members.length) })}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{c.addressRanges}</dt>
          <dd className="break-words font-mono text-xs">
            <BlurIp>{plan.config.network.cidrs.join(", ")}</BlurIp>
          </dd>
          <dt className="text-muted-foreground">{c.mtu}</dt>
          <dd>{plan.config.network.mtu}</dd>
          <dt className="text-muted-foreground">{c.probePort}</dt>
          <dd>{plan.config.network.probePort} · TCP / UDP</dd>
          {plan.rotateKeys && (
            <>
              <dt className="text-muted-foreground">{m.rotateKeys}</dt>
              <dd>
                <ShieldCheck className="size-4 text-primary" />
              </dd>
            </>
          )}
        </dl>
        <div className="divide-y divide-border/50 rounded-xl bg-muted/40">
          {plan.hosts.map((host) => (
            <div key={host.serverId} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
                  <span className="truncate">{host.name}</span>
                  <span aria-hidden="true" className="h-3 w-px shrink-0 self-center bg-border" />
                  <span className="font-mono text-xs font-normal text-muted-foreground">
                    <BlurIp>{host.privateIp}</BlurIp>
                  </span>
                </p>
                <span
                  className={`rounded-md px-2 py-1 text-xs ${host.action === "remove" ? "bg-warning/10 text-warning" : "bg-primary/8 text-primary"}`}
                >
                  {host.action === "remove" ? m.remove : m.configure}
                </span>
              </div>
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Network className="size-3.5" />
                  <span dir="ltr" className="font-mono">
                    <BlurIp>{host.endpoint}</BlurIp>:{host.listenPort}
                  </span>
                  <span>UDP</span>
                </span>
                <span>
                  {m.packages}: {host.packages.length ? host.packages.join(", ") : m.installed}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div
          className={`space-y-2 rounded-xl p-4 text-sm leading-relaxed ${plan.intent === "remove" ? "bg-warning/10 text-warning" : "bg-primary/5 text-muted-foreground"}`}
        >
          <p>{plan.intent === "remove" ? m.removalHint : m.effect}</p>
          {plan.intent !== "remove" && <p>{m.keys}</p>}
          <p>{m.rollbackHint}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {interpolate(m.expires, { time: new Date(plan.expiresAt).toLocaleTimeString() })}
        </p>
      </div>
    </details>
  );
}
