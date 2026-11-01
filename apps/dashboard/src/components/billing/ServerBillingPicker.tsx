"use client";

import { useRouter, usePathname } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import type { ServerDetail } from "@repo/contracts";
import { useBillingScope } from "./BillingWorkspaceContext";
import { scopedBillingHref } from "@/lib/billing-links";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ServerPicker, ServerRowContent } from "@/components/shared/ServerPicker";
import { Button } from "@/components/ui/button";
import { matchesWorkspace } from "@/lib/server-reference";

interface BillingServerInventory {
  servers: ServerDetail[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const BillingServerInventoryContext = createContext<BillingServerInventory | null>(null);
export const BillingServerInventoryProvider = BillingServerInventoryContext.Provider;
export const useBillingServerInventory = () => useContext(BillingServerInventoryContext);

export function billingServersVisible(inventory: BillingServerInventory | null) {
  return Boolean(
    inventory &&
    (inventory.error ||
      inventory.servers.length > 1 ||
      inventory.servers.some(
        ({ managed }) =>
          managed &&
          (managed.resources || managed.planTierId !== "free" || managed.state !== "needs_plan"),
      )),
  );
}

/** Visible server rows share the destination presentation and authorized inventory. */
export function ServerBillingPicker({ compact = false }: { compact?: boolean }) {
  const inventory = useBillingServerInventory();
  const router = useRouter();
  const pathname = usePathname();
  const { workspaceId, organizationId } = useBillingScope();
  const [pending, startTransition] = useTransition();
  const [requestedName, setRequestedName] = useState("");
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  if (!inventory || !billingServersVisible(inventory)) return null;
  const { servers, loading, error, onRetry } = inventory;
  const selected = servers.find((server) => matchesWorkspace(server, workspaceId));
  const selectServer = (server: ServerDetail) => {
    const id = server.managed?.id;
    if (!id || matchesWorkspace(server, workspaceId) || pending) return;
    setRequestedName(server.name || copy.singular);
    startTransition(() =>
      router.push(scopedBillingHref(pathname, { workspaceId: id, organizationId }), {
        scroll: false,
      }),
    );
  };
  const failure = (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground" role="status">
      <p>{copy.billingServersUnavailable}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t.billing.plansRoute.tryAgain}
      </Button>
    </div>
  );
  const announcement = (
    <span role="status" className="sr-only">
      {pending ? interpolate(copy.switchingBilling, { name: requestedName }) : ""}
    </span>
  );

  if (compact)
    return (
      <section
        aria-label={copy.billingServers}
        aria-busy={pending || loading}
        className="flex min-w-0 flex-1 items-center gap-3 md:flex-none"
      >
        {error ? (
          failure
        ) : (
          <div className="min-w-0 flex-1 md:w-80 md:flex-none">
            {servers.length === 1 && selected ? (
              <div className="flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
                <ServerRowContent server={selected} active />
              </div>
            ) : (
              <ServerPicker
                servers={servers}
                selectedId={selected?.id}
                onSelect={selectServer}
                label={copy.chooseBilling}
                showLabel={false}
                disabled={pending || loading}
              />
            )}
          </div>
        )}
        {announcement}
      </section>
    );

  return (
    <section
      className="space-y-3 rounded-2xl bg-card p-5"
      aria-label={copy.billingServers}
      aria-busy={pending || loading}
    >
      <h2 className="text-sm font-medium text-foreground">{copy.billingServers}</h2>
      {error ? (
        failure
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto p-0.5">
          {servers.map((server) => {
            const selected = matchesWorkspace(server, workspaceId);
            const row = <ServerRowContent server={server} active={selected} />;
            if (servers.length === 1 && selected) {
              return (
                <div key={server.id} className="flex items-center gap-3 rounded-xl bg-muted/35 p-3">
                  {row}
                </div>
              );
            }
            return (
              <button
                key={server.id}
                type="button"
                aria-pressed={selected}
                disabled={pending}
                className={`flex w-full items-center gap-3 rounded-xl p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-wait ${selected ? "bg-primary/5 ring-1 ring-primary/30" : "hover:bg-muted/50"}`}
                onClick={() => selectServer(server)}
              >
                {row}
                {selected && (
                  <span
                    className="flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-primary"
                    aria-hidden="true"
                  >
                    <span className="size-1.5 rounded-full bg-primary" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {servers.length > 1 && <p className="text-xs text-muted-foreground">{copy.chooseBilling}</p>}
      {announcement}
    </section>
  );
}
