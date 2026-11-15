"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { ServerRowContent } from "@/components/shared/ServerPicker";

export function ManagementServers({
  atCapacity,
  onUpgrade,
  upgradeDisabled = false,
}: {
  atCapacity: boolean;
  onUpgrade: () => void;
  upgradeDisabled?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.billing.managementDetail;
  const inventory = useServerDestinations();
  const rows = (inventory.data?.servers ?? []).filter(
    (server) => !server.managed && !server.isLocal && server.purpose !== "migration_source",
  );
  const loading = inventory.loading;
  const error = inventory.error;
  const add = atCapacity ? (
    <Button disabled={upgradeDisabled} onClick={onUpgrade}>
      <Icon name="plus" className="size-4" />
      {copy.addServer}
    </Button>
  ) : (
    <Button asChild>
      <Link href="/servers/new">
        <Icon name="plus" className="size-4" />
        {copy.addServer}
      </Link>
    </Button>
  );
  return (
    <section className="@container/manage-servers space-y-5 rounded-2xl bg-card p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{copy.servers}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        {!loading && !error && rows.length > 0 && add}
      </header>
      {error ? (
        <div role="alert" className="space-y-3 text-sm">
          <p className="text-danger">{error}</p>
          <Button variant="secondary" onClick={inventory.refresh}>
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      ) : loading ? (
        <div
          role="status"
          aria-label={t.billing.workspaces.loading}
          className="grid gap-3 @min-[36rem]/manage-servers:grid-cols-2"
        >
          {[0, 1].map((key) => (
            <div key={key} className="h-28 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      ) : rows.length ? (
        <div className="grid gap-3 @min-[36rem]/manage-servers:grid-cols-2">
          {rows.map((server) => (
            <Link
              key={server.id}
              href={`/servers/${encodeURIComponent(server.id)}`}
              className="min-w-0 space-y-4 rounded-xl bg-muted/30 p-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="flex min-w-0 items-center gap-3">
                <ServerRowContent
                  server={{
                    ...server,
                    sshUser: server.sshUser ?? "",
                    sshPort: server.sshPort ?? 22,
                  }}
                />
              </span>
              <span className="block text-xs text-muted-foreground">
                {server.projectCount === 1
                  ? t.billing.workspaces.oneProject
                  : interpolate(t.billing.workspaces.projectCount, {
                      count: String(server.projectCount ?? 0),
                    })}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl bg-muted/20 p-6 text-center">
          <span className="rounded-xl bg-muted/50 p-3">
            <Icon name="server" className="size-6 text-muted-foreground" />
          </span>
          <h3 className="font-medium">{copy.empty}</h3>
          <p className="max-w-sm text-sm text-muted-foreground">{copy.emptyHint}</p>
          {add}
        </div>
      )}
    </section>
  );
}
