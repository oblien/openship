"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import type { BillingOperations, ManagementPlanId } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { managementApi } from "@/lib/api/management";
import { useResourceScope, useScopedMutation } from "@/hooks/use-scoped-resource";
import { useManagementPlan, type ManagementPlanResource } from "./useManagementPlan";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { interpolate, useI18n } from "@/components/i18n-provider";

const money = (cents: number) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
type Quote = Awaited<ReturnType<BillingOperations["purchaseManagement"]>>;

/** Account-scoped billing view shared by the purchase tab and payment returns. */
export function ManagementBilling({
  initialPlan,
  onBusyChange,
}: {
  initialPlan?: ManagementPlanId;
  onBusyChange?: (busy: boolean) => void;
}) {
  const scope = useResourceScope();
  return (
    <ManagementBillingContent
      key={`${scope}:${initialPlan ?? ""}`}
      initialPlan={initialPlan}
      onBusyChange={onBusyChange}
    />
  );
}

function ManagementBillingContent({
  initialPlan,
  onBusyChange,
}: {
  initialPlan?: ManagementPlanId;
  onBusyChange?: (busy: boolean) => void;
}) {
  const resource = useManagementPlan();
  return (
    <ManagementPlan resource={resource} initialPlan={initialPlan} onBusyChange={onBusyChange} />
  );
}

/** The same purchase and recovery flow in Billing and the server connection form. */
export function ManagementPlan({
  resource,
  initialPlan,
  embedded = false,
  onBusyChange,
}: {
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
  // Reuse the original key after uncertain responses; changed selections are
  // refused by the server until the saved checkout has been recovered/canceled.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const run = async <T,>(work: () => Promise<T>, onSuccess?: (result: Awaited<T>) => void) => {
    const result = await action.execute(work);
    if (result !== null) onSuccess?.(result);
    refresh();
  };
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
  const monthly = planAvailable ? planPrice(plan) : null;
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
  return (
    <div className="@container/management min-w-0 space-y-5 max-md:pb-[calc(9rem+env(safe-area-inset-bottom))]">
      {(error || action.error) && (
        <div role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {action.error || error}
          <Button variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        </div>
      )}
      <div className="space-y-1">
        <h2 id={`${supportChoiceId}-title`} className="text-base font-medium text-foreground">
          Openship Manage
        </h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {copy.description}
        </p>
      </div>
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
                      <Button
                        disabled={action.busy}
                        onClick={() =>
                          void run(
                            () => managementApi.confirm(quote.quoteId!),
                            (result) => {
                              setQuote(null);
                              if (result.change?.paymentUrl)
                                window.location.assign(result.change.paymentUrl);
                            },
                          )
                        }
                      >
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
          {!embedded && data.active && (
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
          {data.subscription && (
            <section className="space-y-3 rounded-2xl bg-card p-5">
              <h3 className="font-medium">
                {copy[data.subscription.plan ?? "basic"]} subscription
              </h3>
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
              {data.cloudIncluded && !data.subscription.baseIncluded && (
                <p className="text-sm text-muted-foreground">
                  Cloud includes the base allowance. Your separate base fee ends at renewal; any
                  extra-server charge retains its saved terms.
                </p>
              )}
              {!data.cloudIncluded && data.subscription.baseIncluded && (
                <p className="text-sm text-muted-foreground">
                  Your Cloud coverage ended. This paid allowance lasts until the date above and will
                  not renew at the discounted price. Choose Manage after it ends; we will not raise
                  your charge automatically.
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
                    End management after the paid period? Your apps and data keep running on your
                    servers. Openship will no longer manage them after your allowance ends.
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
          )}
        </aside>
      </div>
    </div>
  );
}
