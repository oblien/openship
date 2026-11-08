"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { BillingOperations, ManagementPlanId } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { managementApi } from "@/lib/api/management";
import { useResourceScope, useScopedMutation } from "@/hooks/use-scoped-resource";
import { useManagementPlan, type ManagementPlanResource } from "./useManagementPlan";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { PlanChangeModal } from "./PlanChangeModal";
import { ManagementServers } from "./ManagementServers";
import { managementMoney as money } from "./management-presentation";
import { ManagementServerSlots } from "./ManagementServerSlots";
import { getApiErrorMessage } from "@/lib/api/client";

type Quote = Awaited<ReturnType<BillingOperations["purchaseManagement"]>>;

/** Account-scoped billing view shared by the purchase tab and payment returns. */
export function ManagementBilling({
  initialPlan,
  onBusyChange,
  detailView = false,
}: {
  detailView?: boolean;
  initialPlan?: ManagementPlanId;
  onBusyChange?: (busy: boolean) => void;
}) {
  const scope = useResourceScope();
  return (
    <ManagementBillingContent
      key={`${scope}:${initialPlan ?? ""}`}
      initialPlan={initialPlan}
      onBusyChange={onBusyChange}
      detailView={detailView}
    />
  );
}

function ManagementBillingContent({
  initialPlan,
  onBusyChange,
  detailView,
}: {
  detailView?: boolean;
  initialPlan?: ManagementPlanId;
  onBusyChange?: (busy: boolean) => void;
}) {
  const resource = useManagementPlan();
  return (
    <ManagementPlan
      resource={resource}
      initialPlan={initialPlan}
      onBusyChange={onBusyChange}
      detailView={detailView}
    />
  );
}

/** The same purchase and recovery flow in Billing and the server connection form. */
export function ManagementPlan({
  resource,
  initialPlan,
  embedded = false,
  onBusyChange,
  detailView = false,
}: {
  detailView?: boolean;
  resource: ManagementPlanResource;
  initialPlan?: ManagementPlanId;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { data, error, loading, refresh } = resource;
  const { t } = useI18n();
  const copy = t.billing.managementPlans;
  const supportChoiceId = useId();
  const serverCountId = useId();
  const action = useScopedMutation();
  useEffect(() => {
    onBusyChange?.(action.busy);
    return () => onBusyChange?.(false);
  }, [action.busy, onBusyChange]);
  const [selectedPlan, setSelectedPlan] = useState<ManagementPlanId | null>(initialPlan ?? null);
  const [servers, setServers] = useState<number | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [cancel, setCancel] = useState(false);
  const [editing, setEditing] = useState<"plan" | "servers" | null>(null);
  const [checkingSlots, setCheckingSlots] = useState(false);
  const [slotError, setSlotError] = useState<string | null>(null);
  const quoteQueue = useRef<Promise<void> | null>(null);
  const scope = useResourceScope();
  // Reuse the original key after uncertain responses; changed selections are
  // refused by the server until the saved checkout has been recovered/canceled.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const run = async <T,>(work: () => Promise<T>, onSuccess?: (result: Awaited<T>) => void) => {
    const result = await action.execute(work);
    if (result !== null) onSuccess?.(result);
    refresh();
  };
  useEffect(() => {
    if (editing !== "servers" || !data?.subscription) {
      setCheckingSlots(false);
      return;
    }
    const saved = data.subscription;
    if (
      servers === null ||
      !Number.isInteger(servers) ||
      servers <= saved.servers ||
      servers > data.pricing.maxServers ||
      data.pendingCheckout ||
      data.change
    )
      return;
    let active = true;
    setQuote(null);
    setSlotError(null);
    setCheckingSlots(true);
    const timer = setTimeout(() => {
      // Serial reads keep an older in-flight preview from replacing a newer saved quote.
      quoteQueue.current = (quoteQueue.current ?? Promise.resolve()).then(async () => {
        if (!active) return;
        try {
          const result = await managementApi.purchase({
            servers,
            plan: saved.plan ?? "basic",
            idempotencyKey: requestKey,
          });
          if (
            result.kind !== "quote" ||
            !result.quoteId ||
            !Number.isSafeInteger(result.monthlyCents) ||
            result.monthlyCents < 0 ||
            result.amountDueNow === null ||
            !Number.isSafeInteger(result.amountDueNow) ||
            result.amountDueNow < 0
          )
            throw new Error(
              "The price could not be verified. Refresh the quote before continuing.",
            );
          if (active) setQuote(result);
        } catch (failure) {
          if (active) setSlotError(getApiErrorMessage(failure));
        } finally {
          if (active) setCheckingSlots(false);
        }
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    editing,
    servers,
    requestKey,
    scope,
    data?.subscription?.plan,
    data?.subscription?.servers,
    data?.subscription?.priceCents,
    data?.cloudIncluded,
    data?.pricing.version,
    data?.pricing.maxServers,
    data?.pricing.monthlyCents,
    data?.pricing.priorityMonthlyCents,
    data?.pricing.extraServerMonthlyCents,
    data?.pricing.includedServers,
    data?.pendingCheckout,
    data?.change,
  ]);
  useEffect(() => {
    if (data?.change && !action.busy) setEditing(null);
  }, [data?.change, action.busy]);
  if (loading)
    return (
      <p role="status" className="text-muted-foreground">
        Loading your management plan…
      </p>
    );
  if (!data)
    return (
      <div role="alert" className="space-y-3 rounded-2xl bg-card p-5">
        <p>{error || "Could not load your management plan."}</p>
        <Button onClick={refresh}>Try again</Button>
      </div>
    );
  const showingDetails = detailView && Boolean(data.subscription);
  const count =
    servers ??
    Math.max(data.pricing.includedServers, data.subscription?.servers ?? data.connectedServers);
  const plan = selectedPlan ?? data.subscription?.plan ?? "basic";
  const planPrice = (id: ManagementPlanId) =>
    (id === "priority"
      ? (data.pricing.priorityMonthlyCents ?? data.pricing.monthlyCents)
      : data.pricing.monthlyCents) -
    (data.cloudIncluded ? data.pricing.monthlyCents : 0) +
    Math.max(0, count - data.pricing.includedServers) * data.pricing.extraServerMonthlyCents;
  const planAvailable = plan !== "priority" || !!data.pricing.priorityMonthlyCents;
  const validCount =
    Number.isInteger(count) &&
    count >= Math.max(data.pricing.includedServers, data.connectedServers) &&
    count <= data.pricing.maxServers;
  const monthly = planAvailable && validCount ? planPrice(plan) : null;
  const selectionDisabled = action.busy || data.pendingCheckout || !!data.change;
  const selectedMatches =
    !!data.subscription &&
    data.subscription.status !== "canceled" &&
    plan === (data.subscription.plan ?? "basic") &&
    count === data.subscription.servers &&
    monthly === data.subscription.priceCents;
  const purchase = () =>
    run(
      () => managementApi.purchase({ servers: count, plan, idempotencyKey: requestKey }),
      (result) => {
        if (result.url) window.location.assign(result.url);
        else setQuote(result);
      },
    );
  const confirmQuote = () => {
    if (!quote?.quoteId) return;
    void run(
      () => managementApi.confirm(quote.quoteId!),
      (result) => {
        setQuote(null);
        setEditing(null);
        if (result.change?.paymentUrl) window.location.assign(result.change.paymentUrl);
      },
    );
  };
  const subscriptionControls = data.subscription && (
    <section className="space-y-3 rounded-2xl bg-card p-5">
      <h3 className="font-medium">{copy[data.subscription.plan ?? "basic"]} subscription</h3>
      {!showingDetails && (
        <>
          <p className="text-sm">
            {money(data.subscription.priceCents)} / month ·{" "}
            {data.subscription.status.replaceAll("_", " ")}
          </p>
          {data.subscription.periodEnd && (
            <p className="text-sm text-muted-foreground">
              {data.subscription.cancelAtPeriodEnd ? "Ends" : "Current period ends"}{" "}
              {new Date(data.subscription.periodEnd).toLocaleDateString()}
            </p>
          )}
        </>
      )}
      {data.cloudIncluded && !data.subscription.baseIncluded && (
        <p className="text-sm text-muted-foreground">
          Cloud includes the base allowance. Your separate base fee ends at renewal; any
          extra-server charge retains its saved terms.
        </p>
      )}
      {!data.cloudIncluded && data.subscription.baseIncluded && (
        <p className="text-sm text-muted-foreground">
          Your Cloud coverage ended. This paid allowance lasts until the date above and will not
          renew at the discounted price. Choose Manage after it ends; we will not raise your charge
          automatically.
        </p>
      )}
      <Button
        variant="secondary"
        disabled={action.busy}
        onClick={() =>
          void run(managementApi.portal, (result) => {
            window.location.assign(result.portalUrl);
          })
        }
      >
        Payment details & invoices
      </Button>
      {data.subscription.status !== "canceled" &&
        (data.subscription.cancelAtPeriodEnd ? (
          <Button
            variant="ghost"
            disabled={action.busy || data.cloudIncluded !== data.subscription.baseIncluded}
            onClick={() => void run(managementApi.resume)}
          >
            Resume renewal
          </Button>
        ) : (
          <Button variant="ghost" disabled={action.busy} onClick={() => setCancel(true)}>
            Cancel renewal
          </Button>
        ))}
      {cancel && (
        <div className="space-y-3 rounded-xl bg-muted/50 p-4">
          <p className="text-sm">
            End management after the paid period? Your apps and data keep running on your servers.
            Openship will no longer manage them after your allowance ends.
          </p>
          <Button
            disabled={action.busy}
            onClick={() =>
              void run(managementApi.cancel, () => {
                setCancel(false);
              })
            }
          >
            Confirm cancellation
          </Button>
          <Button variant="ghost" disabled={action.busy} onClick={() => setCancel(false)}>
            Keep subscription
          </Button>
        </div>
      )}
    </section>
  );
  const recoveryControls = (
    <>
      {data.pendingCheckout && (
        <section className="space-y-3 rounded-2xl bg-card p-5">
          <h3 className="font-medium">Your checkout is saved</h3>
          <p className="text-sm text-muted-foreground">
            Complete payment or cancel it before choosing another plan or allowance. Payment
            confirmation may take a moment.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={action.busy}
              onClick={() =>
                void run(managementApi.resumeCheckout, (result) => {
                  if (result.url) window.location.assign(result.url);
                })
              }
            >
              Resume checkout
            </Button>
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void run(managementApi.cancelCheckout, () => {
                  setRequestKey(crypto.randomUUID());
                })
              }
            >
              Cancel checkout
            </Button>
          </div>
        </section>
      )}
      {data.change && (
        <section className="space-y-3 rounded-2xl bg-card p-5">
          <h3 className="font-medium">
            Subscription change · {data.change.status.replaceAll("_", " ")}
          </h3>
          <p className="text-sm text-muted-foreground">
            Effective {new Date(data.change.effectiveAt).toLocaleString()}. Your current paid
            allowance remains available until the change completes.
          </p>
          <div className="flex flex-wrap gap-3">
            {data.change.paymentUrl && (
              <Button asChild>
                <a href={data.change.paymentUrl}>Complete payment</a>
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void run(managementApi.cancelChange, () => {
                  setRequestKey(crypto.randomUUID());
                })
              }
            >
              Cancel change
            </Button>
          </div>
        </section>
      )}
    </>
  );
  const purchaseContent = (
    <div className="@container/management min-w-0 space-y-5 max-md:pb-[calc(9rem+env(safe-area-inset-bottom))]">
      {(error || action.error) && (
        <div role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {action.error || error}
          <Button variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        </div>
      )}
      <div className={showingDetails ? "sr-only" : "space-y-1"}>
        <h2 id={`${supportChoiceId}-title`} className="text-base font-medium text-foreground">
          Openship Manage
        </h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {copy.description}
        </p>
      </div>
      {showingDetails && editing === "plan" && (
        <div className="grid gap-3 rounded-xl bg-muted/30 p-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">{t.billing.pricing.currentPlan}</p>
            <p className="mt-1 font-medium">
              {copy[data.subscription!.plan ?? "basic"]} · {money(data.subscription!.priceCents)}{" "}
              {copy.perMonth}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {interpolate(t.billing.managementDetail.totalSlots, {
                count: String(data.subscription!.servers),
              })}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {t.billing.managementDetail.selectedPlan}
            </p>
            <p className="mt-1 font-medium">
              {copy[plan]} · {monthly === null ? "—" : money(quote?.monthlyCents ?? monthly)}{" "}
              {copy.perMonth}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {interpolate(t.billing.managementDetail.totalSlots, { count: String(count) })}
            </p>
          </div>
          {monthly !== null && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t.billing.managementDetail.monthlyChange}:{" "}
              {(quote?.monthlyCents ?? monthly) - data.subscription!.priceCents > 0 ? "+" : ""}
              {money((quote?.monthlyCents ?? monthly) - data.subscription!.priceCents)}{" "}
              {copy.perMonth}
            </p>
          )}
        </div>
      )}
      {!planAvailable && (
        <p role="alert" className="text-sm text-warning">
          {t.billing.plansRoute.requestedPlanUnavailable}
        </p>
      )}
      {embedded && data.active && data.connectedServers >= data.serverLimit && (
        <p className="text-sm text-muted-foreground">
          All {data.serverLimit} connected-server slots are in use. Increase the allowance below to
          connect another server.
        </p>
      )}
      <div className="contents items-start gap-6 @min-[58rem]/management:grid @min-[58rem]/management:grid-cols-[minmax(0,1fr)_340px] [@media(max-height:30rem)]:contents">
        <section
          className="@container/manage-plans mt-5 min-w-0 space-y-5 @min-[58rem]/management:mt-0 [@media(max-height:30rem)]:mt-5"
          aria-labelledby={`${supportChoiceId}-title`}
        >
          <div
            role="radiogroup"
            aria-label={copy.label}
            className="grid gap-4 @min-[34rem]/manage-plans:grid-cols-2"
          >
            {(
              [
                "basic",
                ...(data.pricing.priorityMonthlyCents ? ["priority"] : []),
              ] as ManagementPlanId[]
            ).map((id) => (
              <label
                key={id}
                className={`relative flex min-w-0 flex-col rounded-2xl bg-card p-5 text-start text-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                  plan === id ? "bg-gradient-to-b from-primary/5 to-card" : ""
                } ${selectionDisabled ? "cursor-default" : "cursor-pointer"}`}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name={supportChoiceId}
                  value={id}
                  checked={plan === id}
                  aria-label={copy[id]}
                  aria-describedby={`${supportChoiceId}-${id}-details`}
                  disabled={selectionDisabled}
                  onChange={() => {
                    setSelectedPlan(id);
                    setQuote(null);
                    setRequestKey(crypto.randomUUID());
                  }}
                />
                <span className="mb-4 flex min-h-10 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/80">
                    <Icon
                      name={id === "basic" ? "server" : "shield"}
                      className="size-5"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="text-lg font-semibold tracking-tight">{copy[id]}</span>
                </span>
                <span id={`${supportChoiceId}-${id}-details`} className="flex flex-1 flex-col">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-2xl font-medium tracking-tight tabular-nums">
                      {money(planPrice(id))}
                    </span>
                    <span className="text-sm text-muted-foreground">{copy.perMonth}</span>
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    {data.cloudIncluded && id === "basic" && count === data.pricing.includedServers
                      ? copy.cloudBasic
                      : copy.billingNote}
                  </span>
                  <span className="mb-4 mt-2 min-h-10 text-sm leading-5 text-muted-foreground">
                    {id === "priority" ? copy.priorityDescription : copy.basicDescription}
                  </span>
                  <span className="mb-5 space-y-2.5 text-sm text-muted-foreground">
                    <span className="flex items-start gap-2">
                      <Icon name="check" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      {interpolate(copy.serversIncluded, { count: String(count) })}
                    </span>
                    <span className="flex items-start gap-2">
                      <Icon name="check" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      {id === "priority" ? copy.prioritySupport : copy.email}
                    </span>
                  </span>
                </span>
                <span
                  className={buttonVariants({
                    variant: "secondary",
                    className: "w-full",
                  })}
                  aria-hidden="true"
                >
                  {plan === id ? copy.selected : interpolate(copy.select, { name: copy[id] })}
                  <Icon
                    name={plan === id ? "check" : "arrow-right"}
                    className={plan === id ? "size-4" : "size-4 rtl:rotate-180"}
                  />
                </span>
              </label>
            ))}
          </div>
          {!embedded && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <p className="text-sm text-muted-foreground">Need dedicated hardware?</p>
              <Button asChild variant="ghost" size="sm">
                <a
                  href={`mailto:${data.pricing.dedicatedContact}?subject=Dedicated%20Openship%20hosting`}
                >
                  Request a quote
                  <Icon name="arrow-right" className="size-4 rtl:rotate-180" />
                </a>
              </Button>
            </div>
          )}
        </section>
        <aside className="contents min-w-0 space-y-4 @min-[58rem]/management:block @min-[58rem]/management:sticky @min-[58rem]/management:top-6 [@media(max-height:30rem)]:contents">
          <section className="contents rounded-2xl @min-[58rem]/management:block @min-[58rem]/management:bg-card [@media(max-height:30rem)]:contents">
            <div className="mt-5 space-y-5 rounded-t-2xl bg-card p-5 @min-[58rem]/management:mt-0 @min-[58rem]/management:bg-transparent [@media(max-height:30rem)]:mt-5 [@media(max-height:30rem)]:bg-card">
              {!embedded && (
                <div>
                  <h3 className="text-sm font-medium text-foreground">{copy.includedTitle}</h3>
                  <ul className="space-y-3 pt-2">
                    {Object.values(copy.features).map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground"
                      >
                        <Icon
                          name="check"
                          className="mt-1 size-3.5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.cloudIncluded && (
                <p className="text-sm text-muted-foreground">
                  {interpolate(copy.cloudIncluded, {
                    price: money(
                      (data.pricing.priorityMonthlyCents ?? data.pricing.monthlyCents) -
                        data.pricing.monthlyCents,
                    ),
                  })}
                </p>
              )}
              <div className={embedded ? "space-y-4" : "space-y-4 border-t border-border/50 pt-5"}>
                <div className="space-y-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <label htmlFor={serverCountId} className="text-sm font-medium">
                        {copy.serverCount}
                      </label>
                      <p id={`${serverCountId}-hint`} className="text-xs text-muted-foreground">
                        {interpolate(copy.extraServers, {
                          included: String(data.pricing.includedServers),
                          price: money(data.pricing.extraServerMonthlyCents),
                        })}
                      </p>
                    </div>
                    <Input
                      id={serverCountId}
                      aria-describedby={`${serverCountId}-hint`}
                      className="h-10 w-20 shrink-0 tabular-nums"
                      variant="filled"
                      type="number"
                      min={Math.max(data.pricing.includedServers, data.connectedServers)}
                      max={data.pricing.maxServers}
                      value={count}
                      disabled={selectionDisabled}
                      onChange={(event) => {
                        setServers(Number(event.target.value));
                        setQuote(null);
                        setRequestKey(crypto.randomUUID());
                      }}
                    />
                  </div>
                </div>
                {quote ? (
                  <div className="space-y-3 rounded-xl bg-muted/50 p-4">
                    <p className="font-medium">Review your change</p>
                    <p className="text-sm">
                      {money(quote.monthlyCents)} / month · {money(quote.amountDueNow ?? 0)} due now
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Effective{" "}
                      {quote.effectiveAt
                        ? new Date(quote.effectiveAt).toLocaleString()
                        : "after payment"}
                      . Increased allowances activate after payment is confirmed.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <Button disabled={action.busy} onClick={confirmQuote}>
                        Confirm change
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={action.busy}
                        onClick={() => {
                          setQuote(null);
                          setRequestKey(crypto.randomUUID());
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
                {!data.purchasesAvailable && (
                  <p className="text-sm text-muted-foreground">
                    New purchases are not available yet. Existing paid access and cancellation
                    remain available.
                  </p>
                )}
              </div>
            </div>
            <div
              className="sticky bottom-0 z-20 space-y-4 rounded-b-2xl border-t border-border/50 bg-background p-5 [padding-bottom:max(1.25rem,env(safe-area-inset-bottom))] max-md:fixed max-md:inset-x-4 max-md:rounded-t-2xl"
              style={{ backgroundImage: "linear-gradient(var(--card), var(--card))" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs text-muted-foreground">{copy.monthlyTotal}</p>
                <p className="text-lg font-medium tabular-nums text-foreground">
                  {monthly === null ? "—" : money(monthly)}
                  <span className="ms-1 text-sm font-normal text-muted-foreground">
                    {copy.perMonth}
                  </span>
                </p>
              </div>
              {!quote &&
                !data.pendingCheckout &&
                !data.change &&
                (monthly === null || monthly > 0) && (
                  <Button
                    className="w-full"
                    disabled={
                      action.busy ||
                      !data.purchasesAvailable ||
                      !planAvailable ||
                      selectedMatches ||
                      (data.subscription?.status !== "canceled" &&
                        !!data.subscription?.cancelAtPeriodEnd) ||
                      !Number.isInteger(count) ||
                      count < Math.max(data.pricing.includedServers, data.connectedServers) ||
                      count > data.pricing.maxServers
                    }
                    onClick={() => void purchase()}
                  >
                    {action.busy
                      ? "Checking…"
                      : selectedMatches
                        ? t.billing.pricing.currentPlan
                        : data.subscription && data.subscription.status !== "canceled"
                          ? "Review change"
                          : "Continue to checkout"}
                  </Button>
                )}
            </div>
          </section>
          {!showingDetails && recoveryControls}
          {!showingDetails && !embedded && data.active && (
            <section className="space-y-4 rounded-2xl bg-card p-5">
              <h3 className="font-medium">Your infrastructure</h3>
              <p>
                <span className="text-3xl font-medium">{data.connectedServers}</span>
                <span className="ms-2 text-muted-foreground">of {data.serverLimit} servers</span>
              </p>
              <p className="text-sm text-muted-foreground">
                Management is active for your paid allowance.
              </p>
              <Button asChild className="w-full">
                <Link href={data.connectedServers < data.serverLimit ? "/servers/new" : "/servers"}>
                  {data.connectedServers < data.serverLimit
                    ? "Connect a server"
                    : "View your servers"}
                </Link>
              </Button>
            </section>
          )}
          {!showingDetails && subscriptionControls}
        </aside>
      </div>
    </div>
  );
  if (!showingDetails) return purchaseContent;
  const saved = data.subscription!;
  const blocked =
    action.busy || data.pendingCheckout || Boolean(data.change) || saved.cancelAtPeriodEnd;
  const openEditor = (mode: "plan" | "servers" = "plan") => {
    if (blocked) return;
    const next = mode === "servers" && saved.status !== "canceled" ? "servers" : "plan";
    setSelectedPlan(saved.plan ?? "basic");
    setServers(next === "servers" ? saved.servers + 1 : saved.servers);
    setQuote(null);
    setSlotError(null);
    action.setError(null);
    setRequestKey(crypto.randomUUID());
    setEditing(next);
  };
  return (
    <div className="@container/manage-detail space-y-5">
      {!editing && (error || action.error) && (
        <p role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {action.error || error}
        </p>
      )}
      <div className="grid items-start gap-5 @min-[64rem]/manage-detail:grid-cols-[minmax(0,1fr)_340px]">
        <ManagementServers
          atCapacity={data.connectedServers >= data.serverLimit}
          onUpgrade={() => openEditor("servers")}
          upgradeDisabled={blocked || data.serverLimit >= data.pricing.maxServers}
        />
        <aside className="min-w-0 space-y-4">
          <section className="space-y-4 rounded-2xl bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
                <Icon name={saved.plan === "priority" ? "shield" : "server"} className="size-5" />
              </span>
              <h2 className="min-w-0 flex-1 text-lg font-medium">{copy[saved.plan ?? "basic"]}</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${data.active ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"}`}
              >
                {data.active ? t.billing.hub.active : t.billing.hub.inactive}
              </span>
            </div>
            <div>
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-xl font-medium">{money(saved.priceCents)}</span>
                <span className="text-xs text-muted-foreground">{copy.perMonth}</span>
              </p>
              {saved.periodEnd && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {interpolate(
                    saved.cancelAtPeriodEnd
                      ? t.billing.sidebar.accessUntil
                      : t.billing.sidebar.renewsOn,
                    { date: new Date(saved.periodEnd).toLocaleDateString() },
                  )}
                </p>
              )}
            </div>
            <div className="flex items-baseline justify-between gap-3 rounded-xl bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">{copy.serverCount}</span>
              <span className="font-medium tabular-nums">
                {data.connectedServers} / {data.serverLimit}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {saved.plan === "priority" ? copy.prioritySupport : copy.email}
            </p>
          </section>
          <Button className="w-full" disabled={blocked} onClick={() => openEditor("plan")}>
            {t.billing.workspaces.changePlan}
            <Icon name="arrow-up-right" className="size-4" />
          </Button>
          <div className="min-w-0 space-y-4">
            {recoveryControls}
            {subscriptionControls}
          </div>
        </aside>
      </div>
      {editing && (
        <PlanChangeModal
          busy={action.busy || checkingSlots}
          title={editing === "servers" ? t.billing.managementDetail.addSlots : undefined}
          width={editing === "servers" ? 480 : 920}
          onClose={() => setEditing(null)}
        >
          {editing === "servers" ? (
            <ManagementServerSlots
              data={data}
              additional={(servers ?? saved.servers + 1) - saved.servers}
              quote={quote}
              checking={checkingSlots}
              busy={action.busy}
              error={slotError || action.error}
              onChange={(additional) => {
                setServers(saved.servers + additional);
                setQuote(null);
                setSlotError(null);
                action.setError(null);
                setRequestKey(crypto.randomUUID());
              }}
              onRetry={() => {
                setQuote(null);
                action.setError(null);
                setRequestKey(crypto.randomUUID());
              }}
              onCheckout={confirmQuote}
            />
          ) : (
            purchaseContent
          )}
        </PlanChangeModal>
      )}
    </div>
  );
}
