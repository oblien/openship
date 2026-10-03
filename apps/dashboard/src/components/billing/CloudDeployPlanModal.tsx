"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { ApiError } from "@/lib/api/client";
import { cloudDeployRecovery, type CloudDeployRestriction } from "@/lib/cloud-deploy-pricing";
import { workspaceBillingHref } from "./BillingWorkspaceContext";
import { CloudPlanPicker } from "./CloudPlanPicker";

export function CloudDeployPlanModal({
  restriction = { code: "CLOUD_BILLING_BLOCKED" },
  onClose,
  workspaceId,
  serverName,
}: {
  restriction?: CloudDeployRestriction;
  workspaceId?: string;
  /** Explicit server setup reuses checkout without presenting a deployment failure. */
  serverName?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.billing.deployGate;
  const closeLabel = serverName !== undefined ? t.billing.workspaces.returnToSetup : copy.close;
  const titleId = useId();
  const descriptionId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const initialOffer = useRef<string | null>(null);
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
      const next = await billingApi.getBillingState(workspaceId);
      if (!mounted.current) return;
      initialOffer.current ??= next.subscription?.offerReference ?? next.tier;
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
  }, [workspaceId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const recovery = state ? cloudDeployRecovery(state, restriction) : "subscribe";
  const planChanged =
    recovery === "upgrade" && state && !state.overQuota &&
    (state.subscription?.offerReference ?? state.tier) !== initialOffer.current;
  const ready = recovery === "ready" || planChanged;
  const readyTitle = serverName !== undefined ? t.billing.workspaces.serverPlanReadyTitle : copy.readyTitle;
  const showPlans = !ready && (recovery === "subscribe" || recovery === "upgrade");
  const title = serverName !== undefined
    ? interpolate(t.billing.workspaces.serverPlanTitle, { name: serverName })
    : recovery === "credits"
      ? copy.creditsTitle
      : recovery === "upgrade"
        ? copy.upgradeTitle
        : recovery === "payment" || recovery === "paused"
          ? copy.blockedTitle
          : copy.title;
  const reason =
    restriction.reason && Object.hasOwn(copy.reasons, restriction.reason)
      ? copy.reasons[restriction.reason as keyof typeof copy.reasons]
      : undefined;
  const description = ready
    ? (serverName !== undefined ? t.billing.workspaces.serverPlanReady : copy.ready)
    : serverName !== undefined && recovery === "subscribe"
      ? t.billing.workspaces.serverPlanDescription
      : recovery === "credits"
        ? copy.creditsDescription
        : recovery === "payment"
          ? copy.paymentDescription
          : recovery === "paused"
            ? copy.pausedDescription
            : recovery === "upgrade"
              ? (reason ?? copy.upgradeDescription)
              : copy.description;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col outline-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 px-4 py-3 sm:px-5">
        <h2
          id={titleId}
          className="min-w-0 text-lg font-semibold leading-6 tracking-tight text-foreground"
        >
          {ready ? readyTitle : title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={closeLabel}
          className="shrink-0"
        >
          <UiIcon name="close" className="size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-5 sm:px-5">
        <p id={descriptionId} className="mb-5 text-sm text-muted-foreground">
          {description}
        </p>
        {loading && !state ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
          >
            <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden="true" />
            {copy.loading}
          </div>
        ) : error ? (
          <p role="alert" className="rounded-xl bg-muted/30 p-5 text-sm">
            {error === "owner" ? copy.ownerRequired : copy.loadError}
          </p>
        ) : (
          state && (
            <div className="space-y-5">
              {showPlans && (
                <CloudPlanPicker
                  workspaceId={state.workspace?.id ?? workspaceId}
                  currentPlan={state.tier}
                  currentOffer={state.plan}
                  allocatedDiskGb={state.capacity?.diskGb?.used}
                  subscription={state.subscription}
                  complimentary={state.complimentary}
                  billingEnabled={state.billing?.enabled === true}
                  canChangeSubscription={state.capabilities?.subscriptionChange === true}
                  preserveProject
                  onCheckoutStarted={() => {
                    setCheckoutStarted(true);
                    setChecked(false);
                  }}
                />
              )}
              {(recovery === "credits" || recovery === "payment") && (
                <div className="flex flex-wrap gap-3">
                  {recovery === "credits" && state.billing?.enabled && state.topups?.available && (
                    <Button asChild>
                      <a href={workspaceBillingHref("/billing/topups", state.workspace?.id ?? workspaceId)} target="_blank" rel="noopener noreferrer">
                        {copy.topups}
                        <UiIcon name="arrow-up-right" className="size-4" aria-hidden="true" />
                      </a>
                    </Button>
                  )}
                  <Button asChild variant="secondary">
                    <a
                      href={workspaceBillingHref(recovery === "credits" ? "/billing/plans" : "/billing/overview", state.workspace?.id ?? workspaceId)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {copy.manageBilling}
                      <UiIcon name="arrow-up-right" className="size-4" aria-hidden="true" />
                    </a>
                  </Button>
                </div>
              )}
              {recovery === "paused" && (
                <a
                  href="mailto:support@openship.io"
                  className="inline-flex text-sm font-medium text-primary hover:underline"
                >
                  {t.billing.portal.supportButton}
                </a>
              )}
              {checkoutStarted && checked && !loading && !ready && (
                <p role="status" className="text-sm text-muted-foreground">
                  {copy.pending}
                </p>
              )}
            </div>
          )
        )}
        <p className="mt-5 text-xs text-muted-foreground">{copy.preserved}</p>
      </div>

      <footer className="flex shrink-0 items-stretch justify-end gap-2 border-t border-border/40 px-4 py-3 sm:px-5">
        {!ready && error !== "owner" && (
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            className="h-auto min-h-10 min-w-0 flex-1 whitespace-normal px-3 sm:flex-none"
            onClick={() => {
              setChecked(true);
              void refresh();
            }}
          >
            <UiIcon
              name="refresh"
              className={`size-4 shrink-0 ${loading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {error ? t.billing.plansRoute.tryAgain : copy.checkPlan}
          </Button>
        )}
        <Button
          type="button"
          variant={ready ? "default" : "ghost"}
          onClick={onClose}
          className="h-auto min-h-10 min-w-0 flex-1 whitespace-normal px-3 sm:flex-none"
        >
          {closeLabel}
        </Button>
      </footer>
    </div>
  );
}
