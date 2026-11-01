"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { effectiveServiceAlias, firstServicePort, internalServiceAddress, servicePortPairs } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { ServiceStatusBadge } from "@/components/services/ServiceStatusBadge";
import type { Service } from "@/lib/api/services";

/** Subgrid keeps every service on the list's shared column tracks. */
export function ServiceListItem({
  service,
  status,
  href,
  resolvedUrl,
}: {
  service: Service;
  status: string;
  href: string;
  resolvedUrl: string | null;
}) {
  const { t } = useI18n();
  const c = t.projects.services;
  const port = servicePortPairs(service.ports)[0]?.host
    ?? (service.exposedPort ? Number(service.exposedPort) : undefined)
    ?? firstServicePort(service.ports ?? undefined);
  const address = resolvedUrl?.replace(/^https?:\/\//, "") || internalServiceAddress(
    effectiveServiceAlias(service.name, service.advanced?.alias),
    service.ports ?? undefined,
  );
  const visibility = service.exposed ? c.public : c.internal;
  const portLabel = port !== undefined && Number.isFinite(port)
    ? interpolate(c.port, { port: String(port) })
    : null;
  const connectionLabel = [visibility, portLabel].filter(Boolean).join(" · ");
  const drifted = Boolean(service.drift?.changes.length);

  return (
    <li className="col-span-full grid grid-cols-subgrid">
      <Link
        href={href}
        prefetch={false}
        className="group col-span-full grid grid-cols-subgrid items-center px-4 py-3.5 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 @2xl/services-list:px-5"
      >
        <div className="flex min-w-0 items-center gap-3 @2xl/services-list:gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60 transition-colors group-hover:bg-muted">
            <ServiceIcon service={service} className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground" title={service.name} dir="auto">
                {service.name}
              </span>
              {drifted && (
                <span className="shrink-0 text-warning" title={c.upstreamChange}>
                  <Icon name="warning" className="size-3.5" />
                  <span className="sr-only">{c.upstreamChange}</span>
                </span>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center text-xs text-muted-foreground" title={`${address} · ${connectionLabel}`}>
              <span className="sr-only">{connectionLabel}: </span>
              <span className="truncate" dir="auto">{address}</span>
            </div>
          </div>
        </div>

        <div className="hidden min-w-0 items-center justify-center @lg/services-list:flex">
          {portLabel && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground" title={portLabel} dir="ltr">
              <span className="sr-only">{portLabel}</span>
              <span aria-hidden="true">:{port}</span>
            </span>
          )}
        </div>

        <div className="grid items-center gap-3 whitespace-nowrap @sm/services-list:grid-cols-[minmax(0,1fr)_1rem]">
          <div className="flex items-center justify-center">
            <ServiceStatusBadge status={status} />
          </div>
          <Icon name="chevron-right" className="hidden size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground rtl:rotate-180 @sm/services-list:block" />
        </div>
      </Link>
    </li>
  );
}
