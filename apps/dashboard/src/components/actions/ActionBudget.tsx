"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { ActionBudget as BudgetData, ActionCreditPurchase } from "@repo/contracts";
import { billingApi } from "@/lib/api/billing";
import { beginCheckoutNavigation } from "@/lib/checkout-navigation";
import { randomUUID } from "@/lib/random-uuid";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { useI18n } from "@/components/i18n-provider";
import { ActionError } from "./ActionStatus";
import { useActionMutation, useActionResource, useActionScope } from "./useActions";

const unfinished = new Set(["pending", "open", "processing"]);
const paymentInterval = (purchase: ActionCreditPurchase | null) =>
  purchase && unfinished.has(purchase.status) ? 10_000 : 0;
const budgetInterval = (data: BudgetData) =>
  data.balance.fundedUnits > 0 && !data.runnersReady ? 5000 : 30_000;

function Budget({ onClose }: { onClose?: () => void }) {
  const { t, locale } = useI18n();
  const copy = t.actions.budget;
  const params = useSearchParams();
  const purchaseId = params.get("purchase");
  const budget = useActionResource(billingApi.getActionsBudget, budgetInterval);
  const loadPayment = useCallback(
    () =>
      purchaseId && /^acredit_[A-Za-z0-9_-]{1,120}$/.test(purchaseId)
        ? billingApi.getActionsPurchase(purchaseId)
        : Promise.resolve(null),
    [purchaseId],
  );
  const receipt = useActionResource(loadPayment, paymentInterval);
  const mutation = useActionMutation();
  const [selected, setSelected] = useState<number | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const attempts = useRef(new Map<number, string>());
  const data = budget.data;
  const deposit = selected ?? data?.pricing.depositsCents[0] ?? 0;
  const money = (dollars: number, precision = 2) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(dollars);
  const units = (amount: number | null) => {
    if (amount === null) return "—";
    const dollars = amount / (data?.unitsPerDollar ?? 1);
    return money(dollars, dollars !== 0 && Math.abs(dollars) < 0.01 ? 6 : 2);
  };
  // Usage tariffs need sub-cent precision even above one cent (e.g. $0.015).
  const rateUnits = (amount: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }).format(amount / data!.unitsPerDollar);
  const statusLabel = (status: string) =>
    copy.status[status as keyof typeof copy.status] ?? copy.status.pending;

  useEffect(() => {
    if (receipt.data) budget.refresh();
  }, [receipt.data, budget.refresh]);

  async function checkout(id?: string) {
    if (!data?.purchasesAvailable || mutation.busy) return;
    const navigation = beginCheckoutNavigation(!!onClose);
    setCheckoutUrl(null);
    if (!attempts.current.has(deposit)) attempts.current.set(deposit, randomUUID());
    const result = await mutation.execute(() =>
      id
        ? billingApi.resumeActionsCheckout(id)
        : billingApi.createActionsCheckout({
            amountCents: deposit,
            idempotencyKey: attempts.current.get(deposit)!,
          }),
    );
    if (result?.checkoutUrl) {
      const url = result.checkoutUrl;
      const destination = await mutation.execute(async () => navigation.navigate(url));
      if (destination) setCheckoutUrl(destination);
      else navigation.close();
    } else if (result && !id) {
      // A completed/expired intent is no longer a new deposit. A subsequent
      // explicit purchase gets its own key; uncertain responses keep this one.
      attempts.current.delete(deposit);
    }
    if (!result?.checkoutUrl) navigation.close();
    budget.refresh();
  }

  const Container = onClose ? "div" : PageContainer;
  return (
    <Container className="@container space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{copy.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        {onClose ? (
          <Button variant="ghost" onClick={onClose}>
            {t.actions.completion.backToSetup}
          </Button>
        ) : (
          <Button asChild variant="secondary">
            <Link href="/actions">
              <Icon name="arrow-left" className="rtl:rotate-180" />
              {t.actions.back}
            </Link>
          </Button>
        )}
      </header>
      <ActionError message={budget.error} onRetry={budget.refresh} />
      <ActionError message={receipt.error} onRetry={receipt.refresh} />
      <ActionError message={mutation.error} />
      {onClose && checkoutUrl && (
        <Button asChild variant="secondary">
          <a href={checkoutUrl} target="_blank" rel="noopener noreferrer">
            {copy.resume}
          </a>
        </Button>
      )}
      {receipt.data && (
        <div
          role="status"
          className={`rounded-xl px-4 py-3 text-sm ${receipt.data.fundedUnits > 0 ? "bg-success/10 text-success" : "bg-card text-muted-foreground"}`}
        >
          {receipt.data.fundedUnits > 0 && data && !data.runnersReady
            ? data.runnerSetupFailed
              ? copy.setupRetrying
              : copy.preparing
            : statusLabel(receipt.data.status)}
        </div>
      )}
      {budget.loading && !data && (
        <div className="h-64 animate-pulse rounded-2xl bg-card" aria-busy="true" />
      )}
      {data && (
        <div className="grid items-start gap-6 @min-[980px]:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-5">
            <section className="rounded-2xl bg-card p-5">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">{copy.rates}</h2>
                <span className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                  {copy.preview}
                </span>
              </div>
              <ActionError
                message={data.pricing.meter ? null : copy.pricingUnavailable}
                onRetry={budget.refresh}
              />
              <div className="divide-y divide-border/40">
                {data.pricing.runners.map((runner) => (
                  <div
                    key={runner.id}
                    className="flex flex-wrap items-center gap-3 py-4 first:pt-0"
                  >
                    <span className="rounded-xl bg-muted/50 p-2.5 text-muted-foreground">
                      <Icon name="cpu" className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">
                        <bdi>Linux · {runner.cpuCores} vCPU</bdi>
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <bdi>
                          {runner.memoryMb / 1024} GiB RAM · {runner.diskGb} GiB
                        </bdi>
                      </p>
                    </div>
                    <div className="text-end tabular-nums">
                      <p className="whitespace-nowrap text-lg font-semibold">
                        <bdi>
                          {runner.estimatedUnitsPerMinute === null
                            ? "—"
                            : `≈ ${rateUnits(runner.estimatedUnitsPerMinute)}`}
                        </bdi>
                        <span className="ms-1 text-xs font-normal text-muted-foreground">
                          {copy.perMinute}
                        </span>
                      </p>
                      {runner.estimatedUnitsPerMinute !== null &&
                        runner.estimatedUnitsPerMinute > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {copy.estimate
                              .replace(
                                "{minutes}",
                                new Intl.NumberFormat(locale).format(
                                  Math.floor(
                                    ((deposit / 100) * data.unitsPerDollar) /
                                      runner.estimatedUnitsPerMinute,
                                  ),
                                ),
                              )
                              .replace("{amount}", money(deposit / 100, 0))}
                          </p>
                        )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {copy.chargedTime}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                {copy.maxParallel.replace("{count}", String(data.pricing.maxParallel))}
              </p>
            </section>
            <section className="rounded-2xl bg-card p-5">
              <div className="flex items-center gap-2">
                <Icon name="network" className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{copy.transfer}</h2>
              </div>
              {data.pricing.meter && (
                <div className="mt-3 grid gap-2 text-sm @min-[720px]:grid-cols-2">
                  <p>
                    {copy.cpuRate.replace(
                      "{price}",
                      rateUnits(data.pricing.meter.cpuUnitsPerMinute),
                    )}
                  </p>
                  <p>
                    {copy.memoryRate.replace(
                      "{price}",
                      rateUnits(data.pricing.meter.memoryUnitsPerGiBMinute),
                    )}
                  </p>
                  <p>
                    {copy.transferRate.replace(
                      "{price}",
                      rateUnits(data.pricing.meter.networkUnitsPerGb),
                    )}
                  </p>
                  {data.pricing.meter.diskUnitsPerGb > 0 && (
                    <p>
                      {copy.diskRate.replace(
                        "{price}",
                        rateUnits(data.pricing.meter.diskUnitsPerGb),
                      )}
                    </p>
                  )}
                </div>
              )}
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {copy.transferPolicy}
              </p>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{copy.artifacts}</p>
            </section>
            <section className="overflow-hidden rounded-2xl bg-card">
              <h2 className="px-5 pt-5 text-sm font-semibold">{copy.history}</h2>
              {data.purchases.length ? (
                <div className="mt-3 divide-y divide-border/40">
                  {data.purchases.map((purchase) => (
                    <div
                      key={purchase.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold tabular-nums">
                          <bdi>{money(purchase.priceCents / 100)}</bdi>
                        </p>
                        <time
                          dateTime={purchase.createdAt}
                          className="mt-1 block text-xs text-muted-foreground"
                        >
                          {new Date(purchase.createdAt).toLocaleDateString(locale, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </time>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {statusLabel(purchase.status)}
                      </span>
                      {data.purchasesAvailable && ["pending", "open"].includes(purchase.status) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={mutation.busy}
                          onClick={() => checkout(purchase.id)}
                        >
                          {copy.resume}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-5 py-5 text-sm text-muted-foreground">{copy.empty}</p>
              )}
            </section>
          </div>
          <aside className="space-y-4">
            <section className="rounded-2xl bg-card p-5">
              <h2 className="text-sm text-muted-foreground">{copy.available}</h2>
              <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
                <bdi>{units(data.balance.availableUnits)}</bdi>
              </p>
              <dl className="mt-5 space-y-2.5 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{copy.funded}</dt>
                  <dd className="tabular-nums">
                    <bdi>{units(data.balance.fundedUnits)}</bdi>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{copy.spent}</dt>
                  <dd className="tabular-nums">
                    <bdi>{units(data.balance.spentUnits)}</bdi>
                  </dd>
                </div>
              </dl>
              <div className="mt-4">
                <ActionError
                  message={data.balance.status === "unavailable" ? copy.balanceUnavailable : null}
                  onRetry={budget.refresh}
                />
                {data.balance.blocking && (data.balance.availableUnits ?? 0) > 0 && (
                  <p className="text-xs leading-relaxed text-muted-foreground" role="status">
                    {copy.paused}
                  </p>
                )}
                {data.balance.fundedUnits > 0 && !data.runnersReady && (
                  <p className="text-xs leading-relaxed text-muted-foreground" role="status">
                    {data.runnerSetupFailed ? copy.setupRetrying : copy.preparing}
                  </p>
                )}
                {data.runnersReady &&
                  !data.balance.blocking &&
                  (onClose ? (
                    <Button variant="secondary" className="w-full" onClick={onClose}>
                      {t.actions.completion.backToSetup}
                    </Button>
                  ) : (
                    <Button asChild variant="secondary" className="w-full">
                      <Link href="/actions/new">{copy.runWorkflow}</Link>
                    </Button>
                  ))}
              </div>
            </section>
            <section className="rounded-2xl bg-card p-5">
              <h2 className="text-base font-semibold">{copy.addFunds}</h2>
              <div role="group" aria-label={copy.deposit} className="mt-4 grid grid-cols-2 gap-2.5">
                {data.pricing.depositsCents.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    aria-pressed={amount === deposit}
                    disabled={mutation.busy}
                    onClick={() => setSelected(amount)}
                    className={`rounded-xl border p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring ${optionCardSurface(amount === deposit)}`}
                  >
                    <span className="block text-lg font-semibold tabular-nums">
                      <bdi>{money(amount / 100, 0)}</bdi>
                    </span>
                  </button>
                ))}
              </div>
              <Button
                className="mt-4 w-full"
                disabled={!data.purchasesAvailable || mutation.busy}
                onClick={() => checkout()}
              >
                {copy.addAmount.replace("{amount}", money(deposit / 100, 0))}
              </Button>
              {!data.purchasesAvailable && (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {copy.unavailable}
                </p>
              )}
            </section>
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">{copy.connected}</p>
          </aside>
        </div>
      )}
    </Container>
  );
}

export function ActionBudget() {
  const scope = useActionScope();
  return <Budget key={scope} />;
}

export function ActionBudgetDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const scope = useActionScope();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      surface="frosted"
      width="1040px"
      maxWidth="calc(100vw - 32px)"
      maxHeight="calc(100dvh - 32px)"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t.actions.budget.title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="p-4 outline-none sm:p-5"
      >
        <Budget key={scope} onClose={onClose} />
      </div>
    </Modal>
  );
}
