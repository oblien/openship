"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useState } from "react";
import { effectiveServiceAlias, internalServiceAddress } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import type { Service, ServiceContainer } from "@/lib/api/services";
import { ServicePortsCard, type ServiceDomainIntent } from "./ServicePortsCard";
import { UsedByCard } from "../UsedByCard";

export function ServiceOverview({ service, container, projectId, deployTarget, onDomains, onSettings }: {
  service: Service;
  container?: ServiceContainer;
  projectId: string;
  deployTarget?: string | null;
  onDomains: (intent: ServiceDomainIntent) => void;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const copy = t.projectDetail.services.detail;
  const sourceLabels = t.projectDetail.services.settingsForm;
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const alias = effectiveServiceAlias(service.name, service.advanced?.alias);
  const address = internalServiceAddress(alias, service.ports?.length ? service.ports : (service.exposedPort ? [service.exposedPort] : []));
  const sourceDetails = [
    { label: sourceLabels.image, value: service.image?.trim() },
    { label: sourceLabels.buildContext, value: service.build?.trim() },
  ].filter((item): item is { label: string; value: string } => !!item.value);
  const details = [
    { label: copy.currentIp, value: container?.ip },
    { label: copy.hostPort, value: container?.hostPort ? String(container.hostPort) : null },
    { label: deployTarget === "cloud" ? copy.workspaceId : copy.containerId, value: container?.containerId },
    { label: copy.restartPolicy, value: service.restart },
    { label: copy.command, value: service.command },
    { label: copy.dependsOn, value: service.dependsOn?.join(", ") },
  ].filter((item): item is { label: string; value: string } => !!item.value);
  const copyValue = async (value: string) => {
    try {
      await copyText(value);
      setCopied(value);
    } catch {
      showToast(copy.networking.copyFailed, "error");
    }
  };

  return (
    <div className="space-y-5">
      <ServicePortsCard service={service} onDomains={onDomains} onConfigure={onSettings} />
      <section className="rounded-2xl border border-border/50 bg-card px-5 py-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <UiIcon name="network" className="size-4 text-muted-foreground" />{copy.networking.privateNetwork}
          </h3>
          <Button variant="ghost" size="sm" onClick={onSettings}><UiIcon name="edit" className="size-3.5" />{copy.networking.configure}</Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-foreground">{copy.internalAddress}</p>
            <p className="mt-1 text-xs text-muted-foreground">{copy.internalAddressHint}</p>
          </div>
          <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-muted/40 py-1 pe-1 ps-3">
            <code className="break-all text-sm text-foreground">{address}</code>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={copy.networking.copyAddress}
              onClick={() => void copyValue(address)}>{copied === address ? <UiIcon name="check" /> : <UiIcon name="copy" />}</Button>
          </div>
        </div>
        {details.length > 0 && (
          <details className="group mt-4 border-t border-border/40 pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <UiIcon name="chevron-down" className="size-3.5 transition-transform group-open:rotate-180" />{copy.networking.runtimeDetails}
            </summary>
            <dl className="mt-4 space-y-3">
              {details.map((item) => (
                <div key={item.label} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <dt className="shrink-0 pt-1 text-xs text-muted-foreground">{item.label}</dt>
                  <dd className="flex min-w-0 items-start gap-2 sm:max-w-[70%]">
                    <code className="min-w-0 break-all py-1 text-xs text-foreground">{item.value}</code>
                    <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={interpolate(copy.networking.copyValue, { label: item.label })}
                      onClick={() => void copyValue(item.value)}>{copied === item.value ? <UiIcon name="check" /> : <UiIcon name="copy" />}</Button>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>
      {sourceDetails.length > 0 && (
        <section className="rounded-2xl border border-border/50 bg-card px-5 py-4" aria-label={sourceLabels.sections.source}>
          <h3 className="mb-3 text-sm font-medium text-foreground">{sourceLabels.sections.source}</h3>
          <dl className="space-y-3">
            {sourceDetails.map((item) => (
              <div key={item.label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <dt className="shrink-0 text-xs text-muted-foreground">{item.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 sm:max-w-[70%]">
                  <code className="min-w-0 truncate text-sm text-foreground" title={item.value}>{item.value}</code>
                  <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={interpolate(copy.networking.copyValue, { label: item.label })}
                    onClick={() => void copyValue(item.value)}>{copied === item.value ? <UiIcon name="check" /> : <UiIcon name="copy" />}</Button>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <UsedByCard projectId={projectId} serviceId={service.id} />
    </div>
  );
}
