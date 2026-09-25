"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/components/i18n-provider";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { ApiError } from "@/lib/api/client";
import { cloudDeployRecovery, type CloudDeployRestriction } from "@/lib/cloud-deploy-pricing";
import { CloudPlanPicker } from "./CloudPlanPicker";
import { CloudUsageGuide } from "./CloudUsageGuide";

export function CloudDeployPlanModal({ restriction, onClose }: {
  restriction: CloudDeployRestriction;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.billing.deployGate;
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const initialTier = useRef<BillingState["tier"] | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const [state, setState] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"owner" | "unavailable" | null>(null);
  const [checkoutStarted, setCheckoutStarted] = useState(false);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const next = await billingApi.getBillingState();
      if (!mounted.current) return;
      initialTier.current ??= next.tier;
      setState(next);
    } catch (err) {
      if (mounted.current) {
        setState(null);
        setError(err instanceof ApiError && err.status === 403 ? "owner" : "unavailable");
      }
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    void refresh();
    return () => {
      mounted.current = false;
      previousFocus?.focus();
    };
  }, [refresh]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex="0"]',
    ) ?? []).filter((element) => !element.closest("[hidden]"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const recovery = state ? cloudDeployRecovery(state, restriction) : "subscribe";
  const planChanged = recovery === "upgrade" && state && !state.overQuota && state.tier !== initialTier.current;
  const ready = recovery === "ready" || planChanged;
  const showPlans = !ready && (recovery === "subscribe" || recovery === "upgrade");
  const title = recovery === "credits" ? copy.creditsTitle
    : recovery === "upgrade" ? copy.upgradeTitle
      : recovery === "payment" || recovery === "paused" ? copy.blockedTitle : copy.title;
  const reason = restriction.reason && Object.hasOwn(copy.reasons, restriction.reason)
    ? copy.reasons[restriction.reason as keyof typeof copy.reasons] : undefined;
  const description = ready ? copy.ready
    : recovery === "credits" ? copy.creditsDescription
      : recovery === "payment" ? copy.paymentDescription
        : recovery === "paused" ? copy.pausedDescription
          : recovery === "upgrade" ? (reason ?? copy.upgradeDescription) : copy.description;

  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      tabIndex={-1} onKeyDown={onKeyDown} className="flex max-h-[88vh] flex-col p-5 outline-none sm:p-8">
      <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary"><UiIcon name="cloud" className="size-5" aria-hidden="true" /></div>
          <div>
            <h2 id={titleId} className="text-xl font-semibold tracking-tight text-foreground">{ready ? copy.readyTitle : title}</h2>
            <p id={descriptionId} className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label={copy.close} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted focus-visible:outline-primary">
          <UiIcon name="close" className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
      {loading && !state ? (
        <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />{copy.loading}
        </div>
      ) : error ? (
        <p role="alert" className="rounded-xl border border-border bg-muted/30 p-5 text-sm">
          {error === "owner" ? copy.ownerRequired : copy.loadError}
        </p>
      ) : state && (
        <div className="space-y-6">
          {showPlans && <CloudUsageGuide collapsible />}
          {showPlans && <CloudPlanPicker
            currentPlan={state.tier}
            subscription={state.subscription}
            billingEnabled={state.billing?.enabled === true}
            canChangeSubscription={state.capabilities?.subscriptionChange === true}
            preserveProject
            onCheckoutStarted={() => { setCheckoutStarted(true); setChecked(false); }}
          />}
          {(recovery === "credits" || recovery === "payment") && (
            <div className="flex flex-wrap gap-3">
              {recovery === "credits" && state.billing?.enabled && state.topups?.available && (
                <a href="/billing/topups" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                  {copy.topups}<UiIcon name="arrow-up-right" className="size-4" aria-hidden="true" />
                </a>
              )}
              <a href={recovery === "credits" ? "/billing/plans" : "/billing/overview"} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium">
                {copy.manageBilling}<UiIcon name="arrow-up-right" className="size-4" aria-hidden="true" />
              </a>
            </div>
          )}
          {recovery === "paused" && <a href="mailto:support@openship.io" className="inline-flex text-sm font-medium text-primary hover:underline">{t.billing.portal.supportButton}</a>}
          {checkoutStarted && checked && !loading && !ready && <p role="status" className="text-sm text-muted-foreground">{copy.pending}</p>}
        </div>
      )}
      </div>

      <div className="mt-5 flex shrink-0 flex-col gap-4 border-t border-border/50 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{copy.preserved}</p>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!ready && error !== "owner" && <button type="button" disabled={loading}
            onClick={() => { setChecked(true); void refresh(); }}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">
            <UiIcon name="refresh" className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            {error ? t.billing.plansRoute.tryAgain : copy.checkPlan}
          </button>}
          <button type="button" onClick={onClose} className={`rounded-lg px-3 py-2 text-sm font-medium ${ready ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
            {copy.close}
          </button>
        </div>
      </div>
    </div>
  );
}
