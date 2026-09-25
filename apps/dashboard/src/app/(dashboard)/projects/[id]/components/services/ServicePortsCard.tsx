"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import type { Service } from "@/lib/api/services";
import { servicePortTargets } from "@/lib/service-endpoints";
import { Button } from "@/components/ui/button";

export interface ServiceDomainIntent {
  port?: number;
  add?: boolean;
}

export function ServicePortsCard({ service, onDomains, onConfigure }: {
  service: Service;
  onDomains: (intent: ServiceDomainIntent) => void;
  onConfigure: () => void;
}) {
  const { t } = useI18n();
  const { baseDomain } = usePlatform();
  const copy = t.projectDetail.services.detail.networking;
  const ports = servicePortTargets(service, baseDomain);
  const paused = !service.enabled || !service.exposed;

  return (
    <section className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
          <UiIcon name="globe" className="size-4 text-muted-foreground" />
          {copy.title}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => onDomains({})}>
          {copy.manageDomains}<UiIcon name="chevron-right" className="size-3.5 rtl:rotate-180" />
        </Button>
      </div>
      {ports.length ? (
        <ul className="divide-y divide-border/40 border-t border-border/40">
          {ports.map((target) => (
            <li key={target.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-5">
              <div className="min-w-0 sm:w-36 sm:shrink-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium tabular-nums text-foreground">{target.label}</span>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{target.protocol}</span>
                </div>
                {target.bindings.filter((binding) => binding.includes(":")).map((binding) => (
                  <p key={binding} className="mt-1 break-all font-mono text-xs text-muted-foreground" title={copy.hostBinding}>{binding}</p>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                {target.endpoints.length ? (
                  <div className="space-y-2">
                    {target.endpoints.map((endpoint) => (
                      <div key={endpoint.hostname} className="flex min-w-0 flex-wrap items-center gap-2">
                        <a href={`https://${endpoint.hostname}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground transition-colors hover:text-primary">
                          <span className="break-all">{endpoint.hostname}</span>
                          <UiIcon name="arrow-up-right" className="size-3.5 shrink-0 text-muted-foreground" />
                        </a>
                        {paused && <span className="text-xs text-muted-foreground">{copy.paused}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{target.protocol === "tcp" ? copy.noDomain : copy.tcpOnly}</p>
                )}
              </div>
              {target.port && target.protocol === "tcp" ? (
                <Button variant="ghost" size="sm" className="self-start"
                  aria-label={interpolate(target.endpoints.length ? copy.managePort : copy.addToPort, { port: target.label })}
                  onClick={() => onDomains({ port: target.port!, add: target.endpoints.length === 0 })}>
                  {target.endpoints.length ? <UiIcon name="chevron-right" className="size-3.5 rtl:rotate-180" /> : <UiIcon name="plus" className="size-3.5" />}
                  {target.endpoints.length ? copy.manage : t.projectSettings.domains.actions.addDomain}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-5 py-5">
          <p className="text-sm text-muted-foreground">{copy.noPorts}</p>
          <Button variant="outline" size="sm" onClick={onConfigure}>{copy.configurePorts}</Button>
        </div>
      )}
    </section>
  );
}
