"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  changeMailPlanHref,
  MAIL_PRODUCTS,
  MAIL_PRODUCT_ICONS,
  mailTierPrice,
  type MailProduct,
} from "@repo/core/managed-mail";
import { Icon } from "@repo/ui/icons";
import { PricingCard, PricingCardGrid } from "./PricingCard";
import { useSidebarCollapseRequest } from "@/context/SidebarLayoutContext";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { mailPlanLabel } from "./plan-presentation";
import { useOptionalCloudPurchase } from "./CloudPurchaseContext";
import { useCloudPlans } from "./useCloudBilling";
import {
  useScopedResource,
  useScopedMutation,
  useResourceScope,
} from "@/hooks/use-scoped-resource";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { OptionCard } from "@/components/shared/OptionCard";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { managedMailApi } from "@/lib/api/managed-mail";

import { MailPlanChange, useMailPlanChange } from "./MailPlanChange";
import { getActiveOrganizationId } from "@/lib/api/client";

type EmailPlansProps = {
  changeTarget?: string;
  requestedStorage?: number;
  requestedPlan?: string | null;
  requestedProduct?: MailProduct;
};

export function EmailPlans({
  changeTarget,
  requestedPlan,
  requestedProduct,
  requestedStorage,
}: EmailPlansProps) {
  const scope = useResourceScope();
  return (
    <EmailPlanCatalog
      key={[scope, changeTarget, requestedProduct, requestedPlan, requestedStorage].join(":")}
      changeTarget={changeTarget}
      requestedStorage={requestedStorage}
      requestedPlan={requestedPlan}
      requestedProduct={requestedProduct}
    />
  );
}

function EmailPlanCatalog({
  changeTarget,
  requestedPlan,
  requestedProduct,
  requestedStorage,
}: EmailPlansProps) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  const account = useScopedResource(managedMailApi.summary);
  const catalog = useCloudPlans();
  const mutation = useScopedMutation();
  const setPurchaseBusy = useOptionalCloudPurchase()?.setBusy;
  const [selection, setMode] = useState<MailProduct>();
  const data = account.data;
  const mail = catalog.payload?.mail;
  const tiers = mail?.tiers ?? [];
  const service =
    changeTarget && changeTarget !== "account"
      ? data?.services?.find((s) => s.id === changeTarget && s.plan && !s.pendingCheckout)
      : undefined;
  const baseStorage =
    mail?.dedicatedStorage?.find((s) => s.storageGB === service?.storageGB) ??
    mail?.dedicatedStorage?.[0];
  const [review, setReview] = useState<{ plan: string; storageGB?: number } | undefined>(
    requestedProduct === "dedicated" && requestedPlan
      ? { plan: requestedPlan, storageGB: requestedStorage }
      : undefined,
  );
  const reviewStorage =
    mail?.dedicatedStorage?.find((size) => size.storageGB === review?.storageGB) ?? baseStorage;
  const purchaseId = useRef<string | undefined>(undefined);
  const closeReview = () => {
    if (!mutation.busy) {
      setReview(undefined);
      purchaseId.current = undefined;
    }
  };
  const titleId = useId();
  const reviewing = tiers.find((item) => item.checkoutPlan && item.id === review?.plan);
  const pendingOrder = data?.services?.find((item) => item.pendingCheckout);
  useSidebarCollapseRequest(tiers.length >= 3);
  const checkoutDisabled = data?.checkoutEnabled === false || !!data?.billingUnavailable;
  const showReview = !!(
    reviewing &&
    reviewStorage &&
    data &&
    !account.error &&
    !checkoutDisabled &&
    (service || data.hostedEnrollmentEnabled !== false) &&
    (changeTarget ? !!service : !pendingOrder)
  );
  const { dialog, onKeyDown } = useDialogFocus(closeReview, showReview);
  const subscribed = !!data?.plan && data.plan !== "included";
  const mode =
    (changeTarget
      ? changeTarget === "account"
        ? (data?.subscriptionPlan?.product ?? data?.defaultProduct ?? data?.product)
        : "dedicated"
      : undefined) ??
    selection ??
    requestedProduct ??
    (requestedPlan ? "mailboxes" : (data?.pendingProduct ?? data?.product ?? "mailboxes"));
  const sending = mode === "sending";
  const activeProduct = data?.product ?? (data?.mailboxPlan === null ? "sending" : "mailboxes");
  const subscriptionProduct = data?.subscriptionPlan?.product ?? activeProduct;
  const addingMailboxes = mode === "mailboxes" && subscriptionProduct === "sending" && !data?.mailboxPlan;
  const target =
    changeTarget ??
    (data?.subscriptionTarget === "account" &&
    (mode === subscriptionProduct || addingMailboxes)
      ? "account"
      : undefined);
  const hostedPurchaseClosed = data?.hostedEnrollmentEnabled === false && !sending &&
    !(service || (target === "account" && subscriptionProduct === "mailboxes"));
  const validTarget = target === "account" ? data?.subscriptionTarget === "account" : !!service;
  const change = useMailPlanChange(validTarget ? target : undefined, account.refresh);
  const busy = mutation.busy || change.actions.busy;
  useEffect(() => {
    setPurchaseBusy?.(busy);
    return () => setPurchaseBusy?.(false);
  }, [setPurchaseBusy, busy]);
  const productName = (product?: MailProduct) =>
    (product && mail?.products?.[product]?.name) ??
    (product === "sending" ? c.apiTitle : c.mailboxesLabel);
  const money = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  async function open(work: () => Promise<{ url: string }>) {
    const result = await mutation.execute(work);
    if (result) window.location.assign(result.url);
    else account.refresh();
  }
  return (
    <section id="email-plans" className="@container/pricing min-w-0 space-y-5">
      {changeTarget && (
        <header className="space-y-3">
          <Link
            href={
              changeTarget === "account"
                ? "/emails?hosting=cloud"
                : "/emails?hosting=cloud&serviceId=" + encodeURIComponent(changeTarget)
            }
            className="inline-flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
            {c.title}
          </Link>
          <h1 className="text-2xl font-medium">{t.billing.workspaces.changePlan}</h1>
          {data && validTarget && (
            <p className="text-sm text-muted-foreground">
              {productName(mode)} ·{" "}
              {mailPlanLabel(service?.plan ?? data.subscriptionPlan?.plan ?? data.plan, c.included)}
              {service && " · " + (service.hostname ?? service.id.slice(-6))}
            </p>
          )}
        </header>
      )}
      {changeTarget && data && !validTarget && <p role="alert">{t.billing.plansRoute.loadError}</p>}
      {target && <MailPlanChange change={change} />}
      {!changeTarget && data && (data.plan || data.pendingPlan || data.hasBillingAccount) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-5">
          <div className="flex items-center gap-3">
            <FeatureIllustration name="mail" className="illustration-color h-auto w-12" />
            <span className="font-medium">
              OpenShip Mail
              {(data.plan || data.pendingPlan) && " · "}
              {data.pendingPlan
                ? interpolate(c.pendingCheckout, {
                    plan:
                      productName(data.pendingProduct) +
                      " · " +
                      mailPlanLabel(data.pendingPlan, c.included),
                  })
                : data.plan &&
                  productName(activeProduct) + " · " + mailPlanLabel(data.plan, c.included)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.plan && (
              <Button asChild variant="secondary">
                <Link href="/emails?hosting=cloud">{c.openDashboard}</Link>
              </Button>
            )}
            {data.subscriptionTarget === "account" && (
              <Button asChild variant="secondary">
                <Link href={changeMailPlanHref("account", getActiveOrganizationId())}>
                  {t.billing.workspaces.changePlan}
                </Link>
              </Button>
            )}
            {data.hasBillingAccount && !data.pendingPlan && (
              <Button
                variant="outline"
                disabled={mutation.busy}
                onClick={() => open(managedMailApi.portal)}
              >
                {t.billing.subscription.manage}
              </Button>
            )}
            {data.pendingPlan && (
              <>
                <Button
                  disabled={mutation.busy || checkoutDisabled || (data.hostedEnrollmentEnabled === false && data.pendingProduct !== "sending")}
                  onClick={() =>
                    open(() => managedMailApi.checkout(data.pendingPlan!, data.pendingProduct))
                  }
                >
                  {c.resumeCheckout}
                </Button>
                <Button
                  variant="ghost"
                  disabled={mutation.busy}
                  onClick={async () => {
                    if (await mutation.execute(managedMailApi.cancelCheckout)) account.refresh();
                  }}
                >
                  {c.cancelCheckout}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {!changeTarget &&
        data?.services
          ?.filter((item) => item.plan)
          .map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4"
            >
              <span className="font-medium">
                {c.dedicatedTitle} · {mailPlanLabel(item.plan, c.included)} · {item.storageGB} GB
              </span>
              <div className="flex gap-2">
                {item.pendingCheckout ? (
                  <>
                    <Button
                      disabled={mutation.busy || checkoutDisabled || data.hostedEnrollmentEnabled === false}
                      onClick={() => open(() => managedMailApi.order(item.id, "resume"))}
                    >
                      {c.resumeCheckout}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={mutation.busy}
                      onClick={async () => {
                        if (await mutation.execute(() => managedMailApi.cancelOrder(item.id)))
                          account.refresh();
                      }}
                    >
                      {c.cancelCheckout}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button asChild variant="secondary">
                      <Link href={changeMailPlanHref(item.id, getActiveOrganizationId())}>
                        {t.billing.workspaces.changePlan}
                      </Link>
                    </Button>
                    <Button asChild variant="secondary">
                      <Link href={"/emails?hosting=cloud&serviceId=" + encodeURIComponent(item.id)}>
                        {c.openDashboard}
                      </Link>
                    </Button>
                    <Button
                      variant="outline"
                      disabled={mutation.busy}
                      onClick={() => open(() => managedMailApi.order(item.id, "portal"))}
                    >
                      {t.billing.subscription.manage}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
      {!changeTarget && mail?.products && (
        <div className="grid gap-3 @2xl/pricing:grid-cols-3" role="group" aria-label={c.plans}>
          {MAIL_PRODUCTS.map((product) => (
            <OptionCard
              key={product}
              value={product}
              selected={product === mode}
              onSelect={() => {
                closeReview();
                setMode(product);
              }}
              icon={<Icon name={MAIL_PRODUCT_ICONS[product]} className="size-5" />}
              label={mail.products[product].name}
              description={mail.products[product].description}
            />
          ))}
        </div>
      )}
      {!hostedPurchaseClosed && mode === "mailboxes" && data && !data.service && data.hostingAvailable === false && (
        <p role="status" className="text-sm text-muted-foreground">
          {c.sharedUnavailable}
        </p>
      )}
      {(account.error || catalog.error || mutation.error || data?.billingUnavailable) && (
        <div role="alert" className="text-sm">
          {account.error || catalog.error || mutation.error || t.billing.plansRoute.loadError}{" "}
          <Button
            variant="link"
            onClick={() => {
              account.refresh();
              catalog.retry();
              mutation.setError(null);
            }}
          >
            {t.emails.sidebar.steps.retry}
          </Button>
        </div>
      )}
      {(data?.checkoutEnabled === false || hostedPurchaseClosed) && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.billing.checkoutUnavailable.checkoutTitle}
        </p>
      )}
      {catalog.loading && !catalog.payload?.mail && <p role="status">{c.loadingPlans}</p>}
      {!catalog.loading && !catalog.payload?.mail && !catalog.error && (
        <p role="status">
          {t.billing.plansRoute.loadError}{" "}
          <Button variant="link" onClick={catalog.retry}>
            {t.emails.sidebar.steps.retry}
          </Button>
        </p>
      )}
      {!(mode === "dedicated" && !baseStorage) && (
        <PricingCardGrid count={tiers.length}>
          {tiers.map((tier) => {
            const plan = tier.checkoutPlan;
            const current = service
              ? service.plan === tier.id
              : target === "account" && data?.subscriptionPlan
                ? data.subscriptionPlan.product === mode && data.subscriptionPlan.plan === tier.id
                : subscribed && activeProduct === mode && data.plan === tier.id;
            const facts = [
              [c.recipientsLabel, tier.recipients.toLocaleString(locale)],
              [c.domainsLabel, tier.domains.toLocaleString(locale)],
              ...(sending
                ? []
                : [
                    ...(mode === "dedicated"
                      ? []
                      : [[c.mailboxesLabel, tier.mailboxes.toLocaleString(locale)]]),
                    [
                      c.storageLabel,
                      (mode === "dedicated"
                        ? baseStorage!.storageGB
                        : tier.storageMB / 1024
                      ).toLocaleString(locale) + " GB",
                    ],
                  ]),
            ];
            return (
              <PricingCard
                key={tier.id}
                name={tier.name}
                icon={<Icon name={MAIL_PRODUCT_ICONS[mode]} className="size-5" />}
                popularLabel={tier.popular ? t.billing.pricing.mostPopular : undefined}
                selected={
                  target
                    ? current
                    : tier.id === requestedPlan && mode === (requestedProduct ?? "mailboxes")
                }
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-2xl font-medium tracking-tight tabular-nums">
                    {money.format(mailTierPrice(tier, mode, baseStorage) / 100)}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground">{c.perMonth}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {mode === "dedicated" && baseStorage ? (
                    <>
                      {money.format(baseStorage.vmMonthlyCents / 100)} VM ·{" "}
                      {money.format(tier.sendingMonthlyCents / 100)} {mail?.products.sending.name}
                    </>
                  ) : (
                    t.billing.subscription.billedMonthly
                  )}
                </p>
                <p className="mb-4 mt-2 min-h-10 text-sm leading-5 text-muted-foreground">
                  {tier.description}
                </p>
                <Button
                  className="w-full"
                  variant={tier.popular ? "default" : "secondary"}
                  disabled={
                    !plan ||
                    !data ||
                    checkoutDisabled || hostedPurchaseClosed ||
                    !!account.error ||
                    mutation.busy ||
                    (target
                      ? !validTarget || change.unavailable || (current && mode !== "dedicated")
                      : mode === "dedicated"
                        ? !!pendingOrder
                        : (subscribed && !addingMailboxes) || !!data.pendingPlan)
                  }
                  onClick={() => {
                    if (!plan) return;
                    if (mode === "dedicated")
                      setReview({ plan: tier.id, storageGB: baseStorage?.storageGB });
                    else if (target) void change.reviewChange(plan, undefined, addingMailboxes ? "mailboxes" : undefined);
                    else void open(() => managedMailApi.checkout(plan, mode));
                  }}
                >
                  {current && service
                    ? t.billing.workspaces.changePlan
                    : current
                      ? t.billing.pricing.currentPlan
                      : interpolate(c.choosePlan, { plan: tier.name })}
                  {!current && <Icon name="arrow-right" className="size-3.5 rtl:rotate-180" />}
                </Button>
                <dl className="mt-5 space-y-2 border-t border-border/60 pt-4 text-sm">
                  {facts.map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <dt className="flex items-start gap-2 text-muted-foreground">
                        <Icon
                          name="check"
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-foreground"
                        />
                        {label}
                      </dt>
                      <dd className="tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 flex items-start gap-2 text-sm">
                  <Icon name="check" aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {sending ? c.domainKeys : c.relayIncluded}
                </p>
              </PricingCard>
            );
          })}
        </PricingCardGrid>
      )}
      {showReview && reviewing?.checkoutPlan && reviewStorage && mail && (
        <Modal
          isOpen
          showCloseButton={false}
          onClose={closeReview}
          closable={!mutation.busy}
          width="30rem"
          maxWidth="100%"
        >
          <div
            ref={dialog}
            onKeyDown={onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="space-y-5 p-6 outline-none"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 id={titleId} className="text-xl font-medium">
                {c.dedicatedTitle} · {reviewing.name}
              </h2>
              <Button
                size="icon"
                variant="ghost"
                disabled={mutation.busy}
                aria-label={t.billing.planChange.close}
                onClick={closeReview}
              >
                <Icon name="close" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{mail?.products.dedicated.description}</p>
            <fieldset disabled={mutation.busy}>
              <legend className="mb-2 text-sm font-medium">{c.storageLabel}</legend>
              <div className="flex flex-wrap gap-1 rounded-xl bg-muted/60 p-1">
                {mail.dedicatedStorage.map((size) => (
                  <label key={size.storageGB} className="min-w-20 flex-1">
                    <input
                      disabled={!!service?.storageGB && size.storageGB < service.storageGB}
                      type="radio"
                      name={titleId + "-storage"}
                      value={size.storageGB}
                      checked={reviewStorage.storageGB === size.storageGB}
                      className="peer sr-only"
                      onChange={() => {
                        purchaseId.current = undefined;
                        setReview({ plan: reviewing.id, storageGB: size.storageGB });
                        mutation.setError(null);
                      }}
                    />
                    <span className="flex min-h-10 cursor-pointer items-center justify-center rounded-lg px-2 text-sm font-medium tabular-nums text-muted-foreground hover:text-foreground peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-default peer-disabled:opacity-40">
                      {size.storageGB.toLocaleString(locale)} GB
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <dl className="space-y-3 text-sm">
              {[
                [c.mailVm, money.format(reviewStorage.vmMonthlyCents / 100)],
                [c.apiTitle, money.format(reviewing.sendingMonthlyCents / 100)],
                [c.recipientsLabel, reviewing.recipients.toLocaleString(locale)],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div
              aria-live="polite"
              aria-atomic="true"
              className="border-t pt-4 text-xl font-medium"
            >
              {money.format(mailTierPrice(reviewing, "dedicated", reviewStorage) / 100)}{" "}
              <small>{c.perMonth}</small>
            </div>
            {mutation.error && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error}
              </p>
            )}
            <Button
              className="w-full"
              disabled={
                mutation.busy ||
                change.actions.busy ||
                checkoutDisabled ||
                (!!service &&
                  reviewing.id === service.plan &&
                  reviewStorage.storageGB === service.storageGB)
              }
              onClick={() => {
                if (target) {
                  closeReview();
                  void change.reviewChange(reviewing.checkoutPlan!, reviewStorage.storageGB);
                  return;
                }
                void open(() =>
                  managedMailApi.checkout(reviewing.checkoutPlan!, "dedicated", {
                    storageGB: reviewStorage.storageGB,
                    purchaseId: (purchaseId.current ??= crypto.randomUUID()),
                    expectedMonthlyCents: mailTierPrice(reviewing, "dedicated", reviewStorage),
                  }),
                );
              }}
            >
              {target ? t.billing.planChange.title : c.continueCheckout}
              <Icon name="arrow-right" />
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
