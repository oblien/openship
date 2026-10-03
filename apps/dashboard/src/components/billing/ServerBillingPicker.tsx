"use client";

import { useRouter, usePathname } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import Link from "next/link";
import type { ServerDetail } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useBillingScope } from "./BillingWorkspaceContext";
import { scopedBillingHref } from "@/lib/billing-links";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ServerRowContent } from "@/components/shared/ServerPicker";
import { Button } from "@/components/ui/button";

interface BillingServerInventory {
  servers: ServerDetail[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const BillingServerInventoryContext = createContext<BillingServerInventory | null>(null);
export const BillingServerInventoryProvider = BillingServerInventoryContext.Provider;
export const useBillingServerInventory = () => useContext(BillingServerInventoryContext);

/** Visible server rows share the destination presentation and authorized inventory. */
export function ServerBillingPicker() {
  const inventory = useBillingServerInventory();
  const router = useRouter();
  const pathname = usePathname();
  const { workspaceId, organizationId } = useBillingScope();
  const [pending, startTransition] = useTransition();
  const [requestedName, setRequestedName] = useState("");
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  if (!inventory) return null;
  const { servers, loading, error, onRetry } = inventory;

  return (
    <section className="space-y-3 rounded-2xl bg-card p-5" aria-label={copy.billingServers} aria-busy={pending || loading}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{copy.billingServers}</h2>
        <Button asChild variant="ghost" size="sm" className="h-8 px-2">
          <Link href="/servers/new"><Icon name="plus" className="size-4" aria-hidden="true" />{t.servers.setup.addServer}</Link>
        </Button>
      </div>
      {error ? (
        <div className="space-y-2 text-sm text-muted-foreground" role="status">
          <p>{copy.billingServersUnavailable}</p>
          <Button variant="secondary" size="sm" onClick={onRetry}>{t.billing.plansRoute.tryAgain}</Button>
        </div>
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto p-0.5">
          {servers.map(server => {
            const selected = server.managed?.id === workspaceId;
            const row = <ServerRowContent server={server} active={selected} />;
            if (servers.length === 1 && selected) {
              return <div key={server.id} className="flex items-center gap-3 rounded-xl bg-muted/35 p-3">{row}</div>;
            }
            return (
              <button key={server.id} type="button" aria-pressed={selected} disabled={pending}
                className={`flex w-full items-center gap-3 rounded-xl p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-wait ${selected ? "bg-primary/5 ring-1 ring-primary/30" : "hover:bg-muted/50"}`}
                onClick={() => {
                  const id = server.managed?.id;
                  if (!id || selected) return;
                  setRequestedName(server.name || copy.singular);
                  startTransition(() => router.push(scopedBillingHref(pathname, { workspaceId: id, organizationId }), { scroll: false }));
                }}>
                {row}
                {selected && <span className="flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-primary" aria-hidden="true"><span className="size-1.5 rounded-full bg-primary" /></span>}
              </button>
            );
          })}
        </div>
      )}
      {servers.length > 1 && <p className="text-xs text-muted-foreground">{copy.chooseBilling}</p>}
      <span role="status" className="sr-only">{pending ? interpolate(copy.switchingBilling, { name: requestedName }) : ""}</span>
    </section>
  );
}
