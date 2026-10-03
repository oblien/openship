"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import { billingApi, type BillingState, type BillingCreditAlerts } from "@/lib/api/billing";
import { getActiveOrganizationId, subscribeActiveOrganization } from "@/lib/api/client";
import { formatMilliCredits } from "@/lib/billing-usage";
import { scopedBillingHref } from "@/lib/billing-links";

type CreditState = Pick<BillingState, "workspace" | "creditAlert" | "tier" | "currentPeriod" | "balance" | "billing" | "topups">;
type Snapshot = { scope: string; value: BillingCreditAlerts };

function alertPriority(state: CreditState): number {
  const alert = state.creditAlert;
  const funded = state.tier !== "free" || (alert?.limit ?? 0) > 0 || state.balance.quotaUsed > 0;
  if (!funded || !alert) return 0;
  if (alert.state === "depleted") return 4;
  if (alert.state === "grace") return 3;
  if (alert.state !== "low") return 0;
  return alert.threshold != null && alert.threshold === alert.thresholds.at(-1) ? 2 : 1;
}

/** Read-only warnings. Oblien alone computes the alert and enforces the balance. */
export function CloudCreditAlert() {
  const { user } = useAuth();
  const { selfHosted } = usePlatform();
  const { connected } = useCloud();
  const organizationId = useSyncExternalStore(
    subscribeActiveOrganization,
    getActiveOrganizationId,
    () => null,
  );
  const scope = user && organizationId ? `${user.id}:${organizationId}` : null;
  const enabled = !!scope && (!selfHosted || connected);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    setSnapshot(null);
    if (!enabled || !scope) return;
    let disposed = false,
      pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const value = await billingApi.getCreditAlerts();
        if (!disposed && organizationId === getActiveOrganizationId())
          setSnapshot({ scope, value });
      } catch {
        // Revocation, provider downtime and unknown state never become a warning
        // about some previously selected customer's balance.
        if (!disposed) setSnapshot(null);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, scope, organizationId]);

  if (!enabled || snapshot?.scope !== scope || !organizationId || !user) return null;
  return <CreditAlertTray key={scope} states={snapshot.value.items} organizationId={organizationId} userId={user.id} />;
}

function alertKey(state: CreditState, organizationId: string, userId: string): string {
  return JSON.stringify([
    userId, organizationId, state.workspace?.id, state.creditAlert?.namespace,
    state.currentPeriod.end, state.creditAlert?.limit, state.creditAlert?.state, state.creditAlert?.threshold,
  ]);
}

function wasAcknowledged(key: string): boolean {
  try { return sessionStorage.getItem(`openship.creditAlert:${key}`) === "1"; }
  catch { return false; }
}

/** One floating disclosure for all affected subscriptions; it never takes page space or focus. */
export function CreditAlertTray({ states, organizationId, userId }: {
  states: CreditState[];
  organizationId: string;
  userId: string;
}) {
  const { t } = useI18n();
  const copy = t.billing.creditAlert;
  const contentId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const acknowledged = useRef(new Set<string>());
  const [expanded, setExpanded] = useState(false);
  const alerts = useMemo(() => states
    .filter(state => alertPriority(state) > 0)
    .sort((a, b) => alertPriority(b) - alertPriority(a))
    .map(state => ({ state, key: alertKey(state, organizationId, userId) })),
  [states, organizationId, userId]);

  useEffect(() => {
    // A renewed allowance or more severe warning is a new notice. Polling the
    // same warning must not undo an explicit dismissal, including after reload.
    if (alerts.some(({ state, key }) => alertPriority(state) >= 2 &&
      !acknowledged.current.has(key) && !wasAcknowledged(key))) setExpanded(true);
  }, [alerts]);

  const collapse = () => {
    setExpanded(false);
    for (const { key } of alerts) {
      acknowledged.current.add(key);
      try { sessionStorage.setItem(`openship.creditAlert:${key}`, "1"); }
      catch { /* In-memory dismissal still works when storage is unavailable. */ }
    }
  };
  if (alerts.length === 0) return null;
  const depleted = alerts[0]!.state.creditAlert?.state === "depleted";

  return (
    <section
      aria-label={copy.title}
      className={`fixed end-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 max-w-[calc(100vw-2rem)] ${expanded ? "w-96" : "w-auto"}`}
      onKeyDown={event => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          collapse();
          trigger.current?.focus();
        }
      }}
    >
      <div className="overflow-hidden rounded-2xl bg-popover shadow-[var(--th-dropdown-shadow)]">
        <button
          ref={trigger}
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded ? copy.hideWarnings : copy.showWarnings}
          title={expanded ? copy.hideWarnings : copy.showWarnings}
          onClick={() => expanded ? collapse() : setExpanded(true)}
          className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-start text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <Icon name="alert-circle" className={`size-5 shrink-0 ${depleted ? "text-danger" : "text-warning"}`} aria-hidden="true" />
          <span className="flex-1">{copy.title}</span>
          {alerts.length > 1 && <span className="text-xs tabular-nums text-muted-foreground">{alerts.length}</span>}
          <Icon name={expanded ? "chevron-down" : "chevron-up"} className="size-4 text-muted-foreground" aria-hidden="true" />
        </button>
        {expanded && (
          <div id={contentId} className="max-h-[min(60dvh,28rem)] space-y-3 overflow-y-auto overscroll-contain px-4 pb-4">
            {alerts.map(({ key, state }) => <CreditAlertNotice key={key} state={state} organizationId={organizationId} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function CreditAlertNotice({ state, organizationId }: { state: CreditState; organizationId: string }) {
  const { t, locale } = useI18n();
  const copy = t.billing.creditAlert;
  const alert = state.creditAlert!;
  const title = alert.state === "depleted" ? copy.exhaustedTitle
    : alert.state === "grace" ? copy.graceTitle : copy.lowTitle;
  const description = alert.state === "depleted" ? copy.exhaustedDescription
    : interpolate(alert.state === "grace" ? copy.graceDescription : copy.lowDescription, {
      percent: String(alert.percent ?? ""),
      credits: formatMilliCredits(Math.max(0, (alert.state === "grace" ? alert.balance : alert.remaining) ?? 0), locale),
    });
  const canTopUp = state.billing?.enabled && state.topups?.available;
  const href = scopedBillingHref(canTopUp ? "/billing/topups" : "/billing/overview", {
    organizationId,
    workspaceId: state.workspace?.id,
  });

  return (
    <article className="rounded-xl bg-muted/40 p-3">
      {state.workspace?.name && <h2 className="break-words text-sm font-medium text-foreground">{state.workspace.name}</h2>}
      <p role="status" className={`mt-1 text-sm font-medium ${alert.state === "depleted" ? "text-danger" : "text-warning"}`}>{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      <Button asChild variant="secondary" size="sm" className="mt-3">
        <Link href={href}>{canTopUp ? copy.buyCredits : copy.openBilling}</Link>
      </Button>
    </article>
  );
}
