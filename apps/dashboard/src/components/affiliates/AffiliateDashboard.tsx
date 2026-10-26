"use client";
import { useCallback, useState } from "react";
import type {
  AffiliateOverview,
  AffiliateOffer,
  AffiliateReferral,
  AffiliatePayout,
  AffiliatePayoutDestinationSummary,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/Tabs";
import { Modal } from "@/components/ui/Modal";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { affiliateRequest } from "@/lib/api/affiliates";
import { reportClientError } from "@/lib/error-reporting";
import { randomUUID } from "@/lib/random-uuid";
import { affiliateDate, affiliateMoney, payoutCents } from "./affiliate-presentation";
import { AffiliateEmptyState } from "./AffiliateEmptyState";
import { AffiliateSidebar } from "./AffiliateSidebar";
import { PayoutDestinationForm } from "./PayoutDestinationForm";
import { PayoutMethodIcon } from "./PayoutMethodIcon";
import { CreateAffiliateLink } from "./CreateAffiliateLink";

const overview = () => affiliateRequest("overview");
const pageSize = 10;
type Tab = "offers" | "referrals" | "payouts";
function useCopy() {
  const { t } = useI18n();
  return t.affiliates;
}
function ErrorMessage({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
      {message}
    </p>
  ) : null;
}
function Status({ value }: { value: string }) {
  const copy = useCopy();
  return (
    <span
      className={`rounded-lg px-2 py-1 text-xs ${["active", "paid", "credited"].includes(value) ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
    >
      {copy.statuses[value as keyof typeof copy.statuses] ?? value}
    </span>
  );
}

export function AffiliateDashboard() {
  const copy = useCopy(),
    { locale } = useI18n();
  const state = useScopedResource(overview, 60000),
    mutation = useScopedMutation();
  const [tab, setTab] = useState<Tab>("offers"),
    [creating, setCreating] = useState(false),
    [requesting, setRequesting] = useState(false),
    [editingDestination, setEditingDestination] = useState(false),
    [revision, setRevision] = useState(0);
  const refresh = () => {
    state.refresh();
    setRevision((v) => v + 1);
  };
  const data = state.data;
  const canCreateLink = Boolean(
    data?.available && data.member?.enabled && data.program.policies.length,
  );
  const canRequestPayout = Boolean(
    data?.available &&
    data.member?.enabled &&
    data.summary.available > 0 &&
    data.summary.available >= data.member.payoutMinimumCents,
  );
  return (
    <PageContainer className="@container/affiliates space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">{copy.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={refresh} aria-label={copy.refresh}>
            <Icon name="refresh" />
          </Button>
          {canRequestPayout && (
            <Button variant="secondary" onClick={() => setRequesting(true)}>
              <Icon name="credit-card" />
              {copy.request}
            </Button>
          )}
          {canCreateLink && (
            <Button onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {copy.create}
            </Button>
          )}
        </div>
      </header>
      <ErrorMessage message={state.error || mutation.error} />
      {state.loading ? (
        <p role="status" className="text-muted-foreground">
          {copy.loading}
        </p>
      ) : !data ? (
        <Button variant="secondary" onClick={refresh}>
          {copy.retry}
        </Button>
      ) : !data.available ? (
        <AffiliateEmptyState
          title={copy.unavailable}
          description={copy.unavailableHint}
          action={
            <Button variant="secondary" onClick={refresh}>
              {copy.retry}
            </Button>
          }
        />
      ) : !data.member ? (
        <div className="grid items-start gap-6 @min-[980px]/affiliates:grid-cols-[minmax(0,1fr)_340px]">
          <AffiliateEmptyState
            title={copy.joinTitle}
            description={copy.joinHint}
            action={
              <Button
                disabled={mutation.busy || !data.program.policies.length}
                onClick={async () => {
                  if (await mutation.execute(() => affiliateRequest("enroll"))) refresh();
                }}
              >
                <Icon name="plus" size="16" />
                {copy.join}
              </Button>
            }
          />
          <AffiliateSidebar data={data} />
        </div>
      ) : (
        <>
          {!data.member.enabled && (
            <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">{copy.paused}</p>
          )}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[
              [
                copy.available,
                data.summary.available,
                `${copy.minimum}: ${affiliateMoney(data.member.payoutMinimumCents, locale)}`,
              ],
              [copy.earned, data.summary.earned, copy.earnedHint],
              [copy.pending, data.summary.reserved, data.summary.reserved > 0 ? copy.reviewed : ""],
              [copy.paid, data.summary.paid, ""],
            ].map(([label, amount, hint]) => (
              <section key={label} className="rounded-2xl bg-card p-5">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="mt-3 text-2xl font-medium tabular-nums">
                  {affiliateMoney(Number(amount), locale)}
                </p>
                <p className="mt-2 min-h-5 text-xs text-muted-foreground">{hint}</p>
              </section>
            ))}
          </div>
          <section className="min-w-0 space-y-4">
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              idPrefix="affiliates"
              ariaLabel={copy.title}
              tabs={[
                { key: "offers", label: copy.links, icon: "link" },
                {
                  key: "referrals",
                  label: copy.customers,
                  icon: "users",
                  count: data.summary.referrals,
                },
                { key: "payouts", label: copy.payouts, icon: "credit-card" },
              ]}
            />
            <div className="grid items-start gap-6 @min-[980px]/affiliates:grid-cols-[minmax(0,1fr)_340px]">
              <div
                role="tabpanel"
                id={`affiliates-panel-${tab}`}
                aria-labelledby={`affiliates-tab-${tab}`}
                className="min-w-0"
              >
                {tab === "payouts" && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-5">
                    <div className="flex min-w-0 items-center gap-3">
                      {data.member.payoutDestination && (
                        <PayoutMethodIcon method={data.member.payoutDestination.method} />
                      )}
                      <div className="min-w-0">
                        <h2 className="text-sm font-medium">{copy.payoutAccount}</h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {data.member.payoutDestination
                            ? `${copy.payoutMethods[data.member.payoutDestination.method]} · ${data.member.payoutDestination.label}`
                            : copy.addAccountHint}
                        </p>
                      </div>
                    </div>
                    {data.member.enabled && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditingDestination(true)}
                      >
                        {data.member.payoutDestination ? copy.changeAccount : copy.addAccount}
                      </Button>
                    )}
                  </div>
                )}
                <Records
                  key={tab}
                  tab={tab}
                  revision={revision}
                  onChanged={refresh}
                  onCreate={canCreateLink ? () => setCreating(true) : undefined}
                  onViewLinks={() => setTab("offers")}
                  onRequest={canRequestPayout ? () => setRequesting(true) : undefined}
                />
              </div>
              <AffiliateSidebar data={data} payouts={tab === "payouts"} />
            </div>
          </section>
          <PayoutForm
            data={data}
            isOpen={requesting}
            onManageAccount={() => setEditingDestination(true)}
            onClose={() => setRequesting(false)}
            onChanged={() => {
              setRequesting(false);
              setTab("payouts");
              refresh();
            }}
          />
          {editingDestination && (
            <PayoutDestinationForm
              current={data.member.payoutDestination}
              onClose={() => setEditingDestination(false)}
              onSaved={() => {
                setEditingDestination(false);
                refresh();
              }}
            />
          )}
          {creating && (
            <CreateAffiliateLink
              data={data}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                setTab("offers");
                refresh();
              }}
            />
          )}
        </>
      )}
    </PageContainer>
  );
}

function PayoutForm({
  data,
  isOpen,
  onClose,
  onChanged,
  onManageAccount,
}: {
  data: AffiliateOverview;
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  onManageAccount: () => void;
}) {
  const copy = useCopy(),
    { locale } = useI18n(),
    mutation = useScopedMutation();
  const [amount, setAmount] = useState<string | null>(null),
    [key, setKey] = useState(randomUUID);
  const [attemptDestination, setAttemptDestination] =
    useState<AffiliatePayoutDestinationSummary | null>(null);
  const destination = attemptDestination ?? data.member?.payoutDestination;
  const displayAmount = amount ?? (data.summary.available / 100).toFixed(2);
  const cents = payoutCents(displayAmount),
    minimum = data.member!.payoutMinimumCents;
  const valid =
    !!data.member?.enabled &&
    !!destination &&
    cents !== null &&
    cents >= minimum &&
    cents <= data.summary.available;
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      width="480px"
      maxWidth="95vw"
      closable={!mutation.busy}
      showCloseButton={!mutation.busy}
    >
      <form
        role="dialog"
        aria-label={copy.requestTitle}
        className="space-y-5 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || cents === null) return;
          // Keep an uncertain attempt's amount and key when closing and reopening.
          setAmount(displayAmount);
          setAttemptDestination(destination ?? null);
          if (
            await mutation.execute(() =>
              affiliateRequest("requestPayout", {
                amountCents: cents,
                idempotencyKey: key,
                destinationRevision: destination!.revision,
              }),
            )
          ) {
            setAmount(null);
            setAttemptDestination(null);
            setKey(randomUUID());
            onChanged();
          }
        }}
      >
        <h2 className="text-lg font-medium">{copy.requestTitle}</h2>
        <div className="space-y-3 rounded-xl bg-card p-4 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">{copy.available}</span>
            <span className="font-medium">{affiliateMoney(data.summary.available, locale)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">{copy.minimum}</span>
            <span>{affiliateMoney(minimum, locale)}</span>
          </div>
        </div>
        <div className="space-y-3 rounded-xl bg-card p-4">
          <p className="text-sm font-medium">{copy.payoutAccount}</p>
          {destination ? (
            <div className="flex items-center gap-3">
              <PayoutMethodIcon method={destination.method} />
              <p className="text-sm text-muted-foreground">
                {copy.payoutMethods[destination.method]} · {destination.label}
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{copy.addAccountHint}</p>
              <Button variant="secondary" type="button" onClick={onManageAccount}>
                {copy.addAccount}
              </Button>
            </>
          )}
        </div>
        <label className="block space-y-2 text-sm">
          <span>{copy.amount}</span>
          <Input
            variant="filled"
            inputMode="decimal"
            value={displayAmount}
            disabled={mutation.busy}
            placeholder={(data.summary.available / 100).toFixed(2)}
            onChange={(e) => {
              setAmount(e.target.value);
              setAttemptDestination(null);
              setKey(randomUUID());
            }}
          />
        </label>
        <ErrorMessage message={mutation.error} />
        <Button className="w-full" disabled={!valid || mutation.busy} type="submit">
          {copy.request}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">{copy.reservedHint}</p>
        <p className="text-xs leading-5 text-muted-foreground">{copy.requestHint}</p>
      </form>
    </Modal>
  );
}

function Records({
  tab,
  revision,
  onChanged,
  onCreate,
  onViewLinks,
  onRequest,
}: {
  tab: Tab;
  revision: number;
  onChanged: () => void;
  onCreate?: () => void;
  onViewLinks: () => void;
  onRequest?: () => void;
}) {
  const copy = useCopy(),
    { locale, t } = useI18n(),
    mutation = useScopedMutation();
  const [offset, setOffset] = useState(0),
    [revoke, setRevoke] = useState<string | null>(null),
    [customer, setCustomer] = useState<AffiliateReferral | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fetcher = useCallback(() => {
    void revision;
    return affiliateRequest(tab, { limit: pageSize, offset });
  }, [tab, offset, revision]);
  const state = useScopedResource(fetcher);
  const perform = async (operation: () => Promise<unknown>) => {
    if (await mutation.execute(operation)) {
      setRevoke(null);
      onChanged();
      state.refresh();
    }
  };
  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch (error) {
      reportClientError(error, { component: "affiliate-clipboard" });
      mutation.setError(copy.copyFailed);
    }
  };
  return (
    <div className="space-y-3">
      <ErrorMessage message={state.error || mutation.error} />
      {state.loading ? (
        <p role="status" className="p-5 text-muted-foreground">
          {copy.loading}
        </p>
      ) : !state.data ? (
        <Button onClick={state.refresh}>{copy.retry}</Button>
      ) : (
        <>
          {state.data.items.length === 0 && (
            <AffiliateEmptyState
              kind={tab === "offers" ? "links" : tab === "referrals" ? "customers" : "payouts"}
              title={
                tab === "offers"
                  ? copy.emptyLinksTitle
                  : tab === "referrals"
                    ? copy.emptyCustomersTitle
                    : copy.emptyPayoutsTitle
              }
              description={
                tab === "offers"
                  ? copy.emptyLinks
                  : tab === "referrals"
                    ? copy.emptyCustomers
                    : copy.emptyPayouts
              }
              action={
                tab === "offers" ? (
                  onCreate && (
                    <Button onClick={onCreate}>
                      <Icon name="plus" size="16" />
                      {copy.create}
                    </Button>
                  )
                ) : tab === "referrals" ? (
                  <Button variant="secondary" onClick={onViewLinks}>
                    {copy.viewLinks}
                    <Icon name="arrow-right" size="16" />
                  </Button>
                ) : (
                  onRequest && <Button onClick={onRequest}>{copy.request}</Button>
                )
              }
            />
          )}
          {state.data.items.map((item) =>
            tab === "offers"
              ? (() => {
                  const link = item as AffiliateOffer;
                  return (
                    <article key={link.id} className="space-y-4 rounded-2xl bg-card p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="font-medium">{link.name}</h3>
                        <Status value={link.status} />
                      </div>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block break-all rounded-xl bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.url}
                      </a>
                      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                        <span>
                          {copy.yourCommission}: {(link.commissionBps - link.discountBps) / 100}%
                        </span>
                        <span>
                          {copy.discount}: {link.discountBps / 100}%
                        </span>
                        <span>
                          {link.durationMonths} {copy.months}
                        </span>
                        <span>
                          {link.eligiblePlans
                            ? `${copy.selectedPlans}: ${link.eligiblePlans.length} · ${[...new Set(link.eligiblePlans.flatMap((plan) => plan.intervals))].map((interval) => (interval === "annual" ? t.billing.pricing.annual : t.billing.pricing.monthly)).join(" / ")}`
                            : link.planId
                              ? copy.eligiblePlan
                              : copy.allPlans}
                        </span>
                        <span>
                          {copy.expires}:{" "}
                          {link.expiresAt ? affiliateDate(link.expiresAt, locale) : copy.noExpiry}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void copyValue(link.url)}
                        >
                          {copied === link.url ? copy.copied : copy.copyLink}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void copyValue(link.code)}>
                          {copied === link.code ? copy.copied : copy.copyCode}
                        </Button>
                        {link.status === "active" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={mutation.busy}
                            onClick={() => setRevoke(link.id)}
                          >
                            {copy.revoke}
                          </Button>
                        )}
                      </div>
                      {revoke === link.id && (
                        <div className="space-y-3 rounded-xl bg-background p-4">
                          <p className="text-sm">{copy.revokeHint}</p>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={mutation.busy}
                              onClick={() =>
                                void perform(() => affiliateRequest("revokeOffer", { id: link.id }))
                              }
                            >
                              {copy.confirmRevoke}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={mutation.busy}
                              onClick={() => setRevoke(null)}
                            >
                              {copy.cancel}
                            </Button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })()
              : tab === "referrals"
                ? (() => {
                    const referral = item as AffiliateReferral;
                    return (
                      <article key={referral.id} className="space-y-4 rounded-2xl bg-card p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <h3 className="font-medium">{referral.customer}</h3>
                          <Status value={referral.status} />
                        </div>
                        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                          {[
                            [copy.paidThrough, affiliateDate(referral.paidThrough, locale)],
                            [copy.renewal, affiliateDate(referral.nextRenewalAt, locale)],
                            [copy.cycles, referral.paidCycles],
                            [copy.earned, affiliateMoney(referral.earned, locale)],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <dt className="text-xs text-muted-foreground">{label}</dt>
                              <dd className="mt-1">{value}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-xs text-muted-foreground">
                            {copy.rewardsUntil}: {affiliateDate(referral.rewardsUntil, locale)}
                          </p>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setCustomer(referral)}
                          >
                            {copy.payments}
                          </Button>
                        </div>
                      </article>
                    );
                  })()
                : (() => {
                    const payout = item as AffiliatePayout;
                    return (
                      <article
                        key={payout.id}
                        className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-card p-5"
                      >
                        <div>
                          <p className="font-medium">
                            {affiliateMoney(payout.amountCents, locale)}
                          </p>
                          {payout.destination && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {copy.payoutMethods[payout.destination.method]} ·{" "}
                              {payout.destination.label}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {copy.requested}: {affiliateDate(payout.createdAt, locale)}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <Status value={payout.status} />
                          {payout.status === "pending" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={mutation.busy}
                              onClick={() =>
                                void perform(() =>
                                  affiliateRequest("cancelPayout", { id: payout.id }),
                                )
                              }
                            >
                              {copy.cancelRequest}
                            </Button>
                          )}
                        </div>
                      </article>
                    );
                  })(),
          )}
          <Pagination total={state.data.total} offset={offset} onChange={setOffset} />
        </>
      )}
      {customer && <PaymentHistory customer={customer} onClose={() => setCustomer(null)} />}
    </div>
  );
}
function Pagination({
  total,
  offset,
  onChange,
}: {
  total: number;
  offset: number;
  onChange: (n: number) => void;
}) {
  const copy = useCopy();
  if (total <= pageSize && offset === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>
        {Math.min(offset + 1, total)}–{Math.min(offset + pageSize, total)} {copy.of} {total}
      </span>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          {copy.previous}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={offset + pageSize >= total}
          onClick={() => onChange(offset + pageSize)}
        >
          {copy.next}
        </Button>
      </div>
    </div>
  );
}
function PaymentHistory({
  customer,
  onClose,
}: {
  customer: AffiliateReferral;
  onClose: () => void;
}) {
  const copy = useCopy(),
    { locale } = useI18n();
  const [offset, setOffset] = useState(0);
  const fetcher = useCallback(
    () => affiliateRequest("payments", { id: customer.id, limit: pageSize, offset }),
    [customer.id, offset],
  );
  const state = useScopedResource(fetcher);
  return (
    <Modal isOpen onClose={onClose} width="720px" maxWidth="95vw">
      <div role="dialog" aria-label={copy.payments} className="space-y-5 p-6">
        <div>
          <h2 className="text-lg font-medium">{customer.customer}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.payments}</p>
        </div>
        <ErrorMessage message={state.error} />
        {state.loading ? (
          <p role="status">{copy.loading}</p>
        ) : state.data ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="py-3 text-start font-normal">{copy.payment}</th>
                    <th className="text-start font-normal">{copy.commission}</th>
                    <th className="text-start font-normal">{copy.refunds}</th>
                    <th className="text-start font-normal">{copy.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.items.map((payment) => (
                    <tr key={payment.id} className="border-t border-border/30">
                      <td className="py-3">
                        {affiliateDate(payment.periodStart, locale)}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {affiliateMoney(payment.paid, locale)}
                        </span>
                      </td>
                      <td>{affiliateMoney(payment.commission, locale)}</td>
                      <td>{affiliateMoney(payment.reversed, locale)}</td>
                      <td>
                        <Status value={payment.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!state.data.items.length && (
              <p className="text-sm text-muted-foreground">{copy.noPayments}</p>
            )}
            <Pagination total={state.data.total} offset={offset} onChange={setOffset} />
          </>
        ) : (
          <Button onClick={state.refresh}>{copy.retry}</Button>
        )}
      </div>
    </Modal>
  );
}
