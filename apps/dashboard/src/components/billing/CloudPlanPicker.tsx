"use client";

import { ReferralCode, useReferralCode } from "@/components/affiliates/ReferralCode";
import { Button } from "@/components/ui/button";
import { BillingPlansSkeleton } from "@/app/(dashboard)/billing/_components/BillingTabSkeleton";
import { BillingPlanSummary } from "@/app/(dashboard)/billing/_components/billing-shared";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PricingCards } from "@/components/billing/PricingCards";
import { BillingIntervalPicker } from "./BillingIntervalPicker";
import type { PlanTierId } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import type { BillingSubscription } from "@repo/contracts";
import type { BillingState } from "@/lib/api/billing";
import { needsCloudPlan } from "@/lib/billing-presentation";
import { useCloudCheckout, useCloudPlans } from "./useCloudBilling";
import { useBillingWorkspace } from "./BillingWorkspaceContext";
import { CustomPlanConfigurator } from "./CustomPlanConfigurator";
import type { ApiPlan } from "./PricingCards";
import { useSubscriptionChange } from "./useSubscriptionChange";
import { SubscriptionChangeDialog } from "./SubscriptionChangeDialog";
import { SubscriptionChangeStatus } from "./SubscriptionChangeStatus";
import { serverPlanChoices } from "./plan-presentation";
import {
  CloudPurchaseHeaderContent,
  CloudPurchaseScope,
  CloudPurchaseTabs,
  useCloudPurchase,
} from "./CloudPurchaseContext";
import { PayAsYouGoPlan } from "./PayAsYouGoPlan";
import { useSidebarCollapseRequest } from "@/context/SidebarLayoutContext";
import { CloudCheckoutFeedback } from "./CloudCheckoutFeedback";
import { CheckoutRecoveryDialog } from "./CheckoutRecovery";

export function CloudPlanPicker(props: Parameters<typeof PlanPicker>[0]) {
  return (
    <CloudPurchaseScope>
      <PlanPicker {...props} />
    </CloudPurchaseScope>
  );
}

function PlanPicker({
  currentPlan,
  subscription,
  complimentary,
  billingEnabled = false,
  canChangeSubscription = false,
  preserveProject = false,
  onCheckoutStarted,
  workspaceId,
  currentOffer,
  allocatedDiskGb,
  prepareWorkspace,
  onWorkspaceRemoved,
  purchaseDetails,
  purchaseDisabled = false,
  billingState,
  requestedPlanId,
  requestedInterval,
  autoCheckout = false,
  checkoutKey,
  onCheckoutSettled,
  initialReferralCode,
}: {
  initialReferralCode?: string;
  requestedPlanId?: string;
  requestedInterval?: "monthly" | "annual";
  autoCheckout?: boolean;
  checkoutKey?: string;
  onCheckoutSettled?: () => void;
  /** Existing server's saved terms, supplied by the billing route. */
  billingState?: BillingState;
  workspaceId?: string;
  currentPlan: PlanTierId;
  currentOffer?: ApiPlan | null;
  allocatedDiskGb?: number | null;
  billingEnabled?: boolean;
  canChangeSubscription?: boolean;
  subscription?: BillingSubscription | null;
  complimentary?: BillingState["complimentary"];
  preserveProject?: boolean;
  onCheckoutStarted?: (checkoutUrl?: string) => void;
  /** New server acquisition resolves its identity only after choosing a plan. */
  prepareWorkspace?: () => Promise<string>;
  onWorkspaceRemoved?: (workspaceId: string) => void;
  purchaseDetails?: ReactNode;
  purchaseDisabled?: boolean;
}) {
  const { t } = useI18n();
  const referral = useReferralCode(initialReferralCode);
  const purchase = useCloudPurchase();
  const billingWorkspaceId = useBillingWorkspace();
  const selectedWorkspaceId = workspaceId ?? billingWorkspaceId;
  const changes = useSubscriptionChange(selectedWorkspaceId, onCheckoutStarted);
  const workspaceScoped =
    Boolean(workspaceId ?? billingWorkspaceId) ||
    (currentPlan === "free" && !subscription && !complimentary);
  const { payload, loading, error, retry } = useCloudPlans();
  // Preserve the website choice. Older links without an interval advertised monthly billing.
  const [purchaseInterval, setInterval] = useState<"monthly" | "annual">(requestedInterval ?? (autoCheckout ? "monthly" : "annual"));
  const interval =
    subscription && subscription.status !== "canceled" ? subscription.interval : !complimentary && payload?.annual.enabled ? purchaseInterval : "monthly";
  const hasPlan = !needsCloudPlan({ tier: currentPlan, subscription, complimentary });
  const canChooseMode = (!hasPlan || purchase.management) && purchase.tabs !== "none";
  const managing = canChooseMode && purchase.mode === "manage";
  const payg = canChooseMode && purchase.mode === "payg";
  const choices = serverPlanChoices({
    plans: payload?.plans ?? [],
    currentOffer: hasPlan ? currentOffer : null,
    interval,
    allocatedDiskGb,
  });
  const compareUpgrades = hasPlan && Boolean(currentOffer);
  const canUseCustom = Boolean(
    payload?.custom,
  );
  const defaultConfiguration =
    canUseCustom &&
    (subscription?.configuration === "custom" ||
      (compareUpgrades ? choices.upgrades.length === 0 : choices.available.length === 0))
      ? "custom"
      : "plans";
  const choiceKey = `${selectedWorkspaceId ?? "new"}:${subscription?.offerReference ?? currentPlan}`;
  const [choice, setChoice] = useState<{
    key: string;
    configuration: "plans" | "custom";
    other: boolean;
  } | null>(null);
  const selected = choice?.key === choiceKey ? choice : null;
  const configuration = selected?.configuration ?? defaultConfiguration;
  const showOtherPlans = selected?.other ?? false;
  const selectConfiguration = (configuration: "plans" | "custom", other = showOtherPlans) =>
    setChoice({ key: choiceKey, configuration, other });
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
  const requestedPlan = hasPlan ? undefined : choices.available.find((plan) => plan.id === requestedPlanId);
  const requestedIntervalAvailable = requestedInterval !== "annual" ||
    (payload?.annual.enabled && requestedPlan?.price.annual != null);
  const showRequestedPlan = requestedPlan && expandedRequest !== requestedPlanId;
  const visiblePlans = showRequestedPlan
    ? [requestedPlan]
    : compareUpgrades && !showOtherPlans ? choices.upgrades : choices.available;
  const summaryAside = Boolean(
    billingState &&
    hasPlan &&
    !loading &&
    !error &&
    payload &&
    !payg &&
    configuration === "plans" &&
    visiblePlans.length > 0 &&
    visiblePlans.length <= 2,
  );
  useSidebarCollapseRequest(
    !preserveProject && !managing &&
      !loading &&
      !error &&
      Boolean(payload) &&
      (payg || (configuration === "plans" && visiblePlans.length > 2)),
  );
  const canPurchase =
    !complimentary &&
    billingEnabled &&
    needsCloudPlan({ tier: currentPlan, subscription, complimentary }) &&
    (currentPlan === "free" || canChangeSubscription);
  const canModify = Boolean(
    selectedWorkspaceId &&
    !complimentary &&
    billingEnabled &&
    canChangeSubscription &&
    subscription?.status === "active" &&
    !subscription.cancelAtPeriodEnd &&
    !subscription.pendingChange,
  );
  const selectable = canPurchase || canModify;
  const supportNotice = !selectable && !subscription?.pendingChange ? (
    <p className="text-sm leading-6 text-muted-foreground">
      {complimentary
        ? t.billing.complimentary.changeViaSupport
        : billingEnabled
          ? t.billing.plansRoute.changeViaSupport
          : t.billing.plansRoute.billingUnavailable}{" "}
      <a href="mailto:support@openship.io" className="text-primary hover:underline">
        {t.billing.portal.supportButton}
      </a>
    </p>
  ) : null;
  const summary = billingState ? (
    <BillingPlanSummary
      state={billingState}
      compact={!summaryAside}
      notice={complimentary ? supportNotice : null}
    />
  ) : null;
  const {
    startCheckout,
    subscribing,
    error: checkoutError,
    checkoutUrl,
    quoteRevision,
    unavailable,
    dismissUnavailable,
    recovery,
  } = useCloudCheckout({
    enabled: canPurchase && !purchaseDisabled && !payg && !managing && referral.ready,
    affiliateCode: referral.verified,
    preserveProject,
    onCheckoutStarted,
    workspaceId,
    prepareWorkspace,
    onWorkspaceRemoved,
    idempotencyKey: checkoutKey,
    onCheckoutSettled,
  });
  const autoStarted = useRef(false);
  useEffect(() => {
    let disposed = false;
    // The website click selected this preset. Wait for authenticated scope and
    // live availability, and schedule after effect replay so Strict Mode cannot
    // cancel the only attempt during its initial mount cleanup.
    if (autoCheckout && requestedPlan && requestedIntervalAvailable && !loading && !error && canPurchase && !purchaseDisabled && !payg && !managing && !preserveProject && referral.ready && configuration === "plans") {
      void Promise.resolve().then(() => {
        if (disposed || autoStarted.current) return;
        autoStarted.current = true;
        void startCheckout(requestedPlan.id, interval);
      });
    }
    return () => { disposed = true; };
  }, [autoCheckout, requestedPlan?.id, requestedIntervalAvailable, loading, error, canPurchase, purchaseDisabled, payg, managing, preserveProject, referral.ready, configuration, startCheckout, interval]);
  const selectedCurrentPlan =
    hasPlan && subscription?.configuration !== "custom" ? choices.current : null;
  const busy = subscribing !== null || changes.busy;
  const setPurchaseBusy = purchase.setBusy;
  useEffect(() => {
    if (managing) return;
    setPurchaseBusy(canChooseMode && (busy || Boolean(checkoutUrl)));
    return () => setPurchaseBusy(false);
  }, [busy, checkoutUrl, canChooseMode, managing, setPurchaseBusy]);

  const handleSelectPlan = (planTierId: PlanTierId) => {
    if (selectable && planTierId !== selectedCurrentPlan)
      void (canModify ? changes.review(planTierId) : startCheckout(planTierId, interval));
  };

  if (loading)
    return (
      <div className="space-y-5">
        {summary}
        <BillingPlansSkeleton />
      </div>
    );

  if (error || !payload) {
    return (
      <div className="space-y-5">
        {summary}
        <div className="rounded-2xl bg-card p-5">
          <p className="text-sm text-muted-foreground">
            {error || t.billing.plansRoute.genericError}
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={retry} className="mt-3">
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      </div>
    );
  }

  const copy = t.billing.plansRoute;
  const contactPlans = payload.plans.filter(
    (plan) => plan.price.monthly === null && plan.contactSales,
  );
  const title = hasPlan
    ? showOtherPlans
      ? copy.otherPlans
      : copy.upgradeServer
    : purchase.intro.title;
  const description = hasPlan
    ? showOtherPlans
      ? copy.otherPlansHint
      : copy.upgradeHint
    : purchase.intro.description;
  const showIntroduction = !preserveProject && !(canChooseMode && purchase.tabs === "header");

  const controls = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {showRequestedPlan && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setExpandedRequest(requestedPlanId ?? null)}
        >
          {copy.otherPlans}
        </Button>
      )}
      {compareUpgrades && (choices.other.length > 0 || showOtherPlans) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            selectConfiguration(showOtherPlans ? defaultConfiguration : "plans", !showOtherPlans)
          }
        >
          {showOtherPlans ? copy.backToUpgrades : copy.otherPlans}
        </Button>
      )}
      {payload.annual.enabled && !complimentary &&
        (!subscription || subscription.status === "canceled") && (
          <BillingIntervalPicker value={interval} onChange={setInterval} disabled={busy} />
        )}
      {payload.custom && visiblePlans.length > 0 && (
        <div
          role="group"
          aria-label={t.billing.custom.configuration}
          className="inline-flex gap-1 rounded-xl bg-muted/40 p-1"
        >
          {(["plans", "custom"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={configuration === value ? "secondary" : "ghost"}
              aria-pressed={configuration === value}
              disabled={busy || (value === "custom" && !canUseCustom)}
              onClick={() => selectConfiguration(value)}
            >
              {value === "plans"
                ? compareUpgrades && !showOtherPlans
                  ? t.billing.pricing.upgrade
                  : t.billing.custom.presets
                : t.billing.custom.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
  const details =
    showIntroduction || purchaseDetails || !canChooseMode ? (
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        {showIntroduction && (
          <div className="min-w-0 flex-1 basis-96">
            <h2 className="text-base font-medium text-foreground">{title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
          </div>
        )}
        {purchaseDetails}
        {!canChooseMode && controls}
      </div>
    ) : null;

  return (
    <div className="@container/plans">
      <div
        className={
          summaryAside
            ? "grid items-start gap-6 @min-[64rem]/plans:grid-cols-[minmax(0,1fr)_340px]"
            : "space-y-5"
        }
      >
        {summary && (
          <aside
            className={
              summaryAside
                ? "min-w-0 @min-[64rem]/plans:col-start-2 @min-[64rem]/plans:row-start-1"
                : undefined
            }
          >
            {summary}
          </aside>
        )}
        <div
          className={`min-w-0 space-y-5 ${summaryAside ? "@min-[64rem]/plans:col-start-1 @min-[64rem]/plans:row-start-1" : ""}`}
        >
          {canChooseMode && purchase.tabs === "inline" && !purchase.management && <CloudPurchaseTabs />}
          {canPurchase && !payg && !managing && <ReferralCode referral={referral} disabled={busy} />}
          {canChooseMode ? (
            <CloudPurchaseHeaderContent details={details} controls={controls} />
          ) : (
            details
          )}
          <div
            hidden={payg || managing}
            role={canChooseMode ? "tabpanel" : undefined}
            id={canChooseMode ? `${purchase.id}-panel-monthly` : undefined}
            aria-labelledby={canChooseMode ? `${purchase.id}-tab-monthly` : undefined}
            className="space-y-5"
          >
            {subscription?.pendingChange && (
              <SubscriptionChangeStatus
                key={`${selectedWorkspaceId}:${subscription.pendingChange.id}`}
                initial={subscription.pendingChange}
                workspaceId={selectedWorkspaceId}
              />
            )}
            {checkoutUrl && <CloudCheckoutNotice checkoutUrl={checkoutUrl} />}
            {checkoutError && (
              <p role="alert" className="text-sm text-danger">
                {checkoutError}
              </p>
            )}
            {requestedPlanId && !hasPlan && (!requestedPlan || !requestedIntervalAvailable) && (
              <p role="status" className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
                {t.billing.plansRoute.requestedPlanUnavailable}
              </p>
            )}
            {changes.error && !changes.open && (
              <p role="alert" className="text-sm text-danger">
                {changes.error}
              </p>
            )}
            {(!complimentary || !billingState) && supportNotice}
            {configuration === "custom" && payload.custom ? (
              <CustomPlanConfigurator
                key={`${selectedWorkspaceId}:${currentOffer?.offerReference ?? currentPlan}`}
                interval={interval}
                catalog={payload.custom}
                plans={payload.plans}
                ui={payload.ui}
                currentOffer={currentOffer}
                subscription={subscription}
                allocatedDiskGb={allocatedDiskGb}
                disabled={!selectable || purchaseDisabled || payg || managing || (canPurchase && !referral.ready)}
                busy={busy}
                actionLabel={canModify ? t.billing.planChange.review : undefined}
                quoteRevision={quoteRevision}
                onSelect={(quote) => {
                  const custom = { resources: quote.resources, quoteReference: quote.reference };
                  void (canModify
                    ? changes.review(quote.basePlanTierId, custom)
                    : startCheckout(quote.basePlanTierId, interval, custom));
                }}
              />
            ) : visiblePlans.length > 0 ? (
              <PricingCards
                plans={visiblePlans}
                ui={payload.ui}
                currentPlan={selectedCurrentPlan}
                onSelectPlan={handleSelectPlan}
                subscribingPlan={subscribing}
                purchasesDisabled={!selectable || changes.busy || purchaseDisabled || payg || managing || (canPurchase && !referral.ready)}
                selectionLabel={canModify ? t.billing.planChange.review : undefined}
                interval={interval}
                workspaceScoped={workspaceScoped}
              />
            ) : (
              <p className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">
                {copy.noLargerPlan}
              </p>
            )}
          </div>
          {canChooseMode && (
            <div
              hidden={!payg}
              role="tabpanel"
              id={`${purchase.id}-panel-payg`}
              aria-labelledby={`${purchase.id}-tab-payg`}
            >
              <PayAsYouGoPlan
                pricing={payload.computePricing}
                catalog={payload.custom}
                payg={payload.payg}
              />
            </div>
          )}
          {contactPlans.length > 0 && (
            <PricingCards plans={contactPlans} ui={payload.ui} currentPlan={currentPlan} />
          )}
          <SubscriptionChangeDialog actions={changes} workspaceId={selectedWorkspaceId} />
          <CloudCheckoutFeedback failure={unavailable} plans={payload.plans} onClose={dismissUnavailable}
            onRetry={failure => void startCheckout(failure.planTierId, failure.interval, failure.custom)} />
          <CheckoutRecoveryDialog {...recovery} />
        </div>
      </div>
    </div>
  );
}

/** Keep the checkout link available when a destination dialog hands off to status. */
export function CloudCheckoutNotice({ checkoutUrl }: { checkoutUrl: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className="rounded-xl bg-muted/40 p-3 text-sm">
      <p>{t.billing.deployGate.checkoutOpened}</p>
      <a
        href={checkoutUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex font-medium text-primary hover:underline"
      >
        {t.billing.deployGate.continueCheckout}
      </a>
    </div>
  );
}
