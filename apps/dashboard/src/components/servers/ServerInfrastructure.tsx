"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Boxes, Network } from "lucide-react";
import type { ServerInfrastructure as Infrastructure } from "@repo/contracts";
import { systemApi } from "@/lib/api/system";
import { useI18n } from "@/components/i18n-provider";
import { BlurIp } from "@/components/BlurIp";

/** Read only references. Setup and diagnostics remain on the network page. */
export function ServerInfrastructure({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState<Infrastructure | null>(null);
  useEffect(() => {
    let active = true;
    setValue(null);
    void systemApi.getServerInfrastructure(serverId).then(
      (next) => {
        if (active) setValue(next);
      },
      () => {
        if (active) setValue(null);
      },
    );
    return () => {
      active = false;
    };
  }, [serverId]);
  if (!value || (!value.networks.length && !value.cluster)) return null;
  const reference = (href: string, children: ReactNode) =>
    value.canBrowse ? (
      <Link
        href={href}
        className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-muted transition-colors"
      >
        {children}
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      </Link>
    ) : (
      <div className="flex min-w-0 items-center gap-3 px-2 py-2">{children}</div>
    );
  return (
    <div className="space-y-5 rounded-2xl bg-card p-5">
      {value.cluster && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Boxes className="size-4 text-primary" />
            {t.servers.tabsNav.cluster}
          </h3>
          {reference(
            `/servers/clusters/${encodeURIComponent(value.cluster.id)}`,
            <span className="truncate text-sm">{value.cluster.name}</span>,
          )}
        </section>
      )}
      {!!value.networks.length && (
        <section className={value.cluster ? "border-t border-border/50 pt-4" : undefined}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Network className="size-4 text-primary" />
            {t.servers.tabsNav.networking}
          </h3>
          <ul>
            {value.networks.map((network) => (
              <li key={network.id}>
                {reference(
                  `/servers/networks/${encodeURIComponent(network.id)}`,
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{network.name}</span>
                    <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                      <BlurIp>{network.privateIp}</BlurIp>
                    </span>
                  </span>,
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
