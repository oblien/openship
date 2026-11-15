"use client";

import { WorkloadListItem } from "./WorkloadListItem";
import { Icon } from "@repo/ui/icons";
import {
  effectiveServiceAlias,
  firstServicePort,
  internalServiceAddress,
  servicePortPairs,
} from "@repo/core";
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
  const port =
    servicePortPairs(service.ports)[0]?.host ??
    (service.exposedPort ? Number(service.exposedPort) : undefined) ??
    firstServicePort(service.ports ?? undefined);
  const address =
    resolvedUrl?.replace(/^https?:\/\//, "") ||
    internalServiceAddress(
      effectiveServiceAlias(service.name, service.advanced?.alias),
      service.ports ?? undefined,
    );
  const visibility = service.exposed ? c.public : c.internal;
  const portLabel =
    port !== undefined && Number.isFinite(port)
      ? interpolate(c.port, { port: String(port) })
      : null;
  const connectionLabel = [visibility, portLabel].filter(Boolean).join(" · ");
  const drifted = Boolean(service.drift?.changes.length);

  return (
    <WorkloadListItem
      name={service.name}
      href={href}
      icon={<ServiceIcon service={service} className="size-5" />}
      address={address}
      connectionLabel={connectionLabel}
      port={port}
      portLabel={portLabel}
      status={<ServiceStatusBadge status={status} />}
      notice={
        drifted ? (
          <span className="shrink-0 text-warning" title={c.upstreamChange}>
            <Icon name="warning" className="size-3.5" />
            <span className="sr-only">{c.upstreamChange}</span>
          </span>
        ) : undefined
      }
    />
  );
}
