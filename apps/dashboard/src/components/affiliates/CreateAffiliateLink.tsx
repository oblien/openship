"use client";
import { useEffect, useId, useState } from "react";
import type { AffiliateOverview, AffiliatePlanSelection } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useCloudPlans } from "@/components/billing/useCloudBilling";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { affiliateRequest } from "@/lib/api/affiliates";
import { randomUUID } from "@/lib/random-uuid";
import { discountBasisPoints } from "./affiliate-presentation";
import { AffiliatePlanPicker, affiliatePlanOptions } from "./AffiliatePlanPicker";

export function CreateAffiliateLink({
  data,
  onClose,
  onCreated,
}: {
  data: AffiliateOverview;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n(),
    copy = t.affiliates;
  const mutation = useScopedMutation(),
    catalog = useCloudPlans(),
    id = useId();
  const { dialog, onKeyDown } = useDialogFocus(() => {
    if (!mutation.busy) onClose();
  });
  const [step, setStep] = useState<1 | 2>(1);
  const [policyId, setPolicy] = useState(data.program.policies[0]?.id ?? "");
  const [name, setName] = useState("");
  const [discount, setDiscount] = useState("0");
  const [selection, setSelection] = useState<AffiliatePlanSelection[] | null>(null);
  const [expires, setExpires] = useState(false),
    [expiry, setExpiry] = useState("");
  const [key, setKey] = useState(randomUUID);
  const policy = data.program.policies.find((p) => p.id === policyId);
  const bps = discountBasisPoints(discount);
  const discountValid = bps !== null && !!policy && bps <= policy.commissionBps;
  const options = affiliatePlanOptions(
    catalog.payload?.plans ?? [],
    policy,
    catalog.payload?.annual.enabled ?? false,
  );
  const selectionValid =
    selection === null ||
    (selection.length > 0 &&
      selection.every(
        (item) =>
          item.intervals.length > 0 &&
          item.intervals.every((interval) =>
            options.some((option) => option.planId === item.planId && option.interval === interval),
          ),
      ));
  const expiryValid = !expires || (Boolean(expiry) && +new Date(expiry) > Date.now());
  const valid = Boolean(
    data.member?.enabled &&
    policy &&
    discountValid &&
    name.trim().length > 0 &&
    name.trim().length <= 100 &&
    expiryValid &&
    selectionValid &&
    !catalog.loading &&
    !catalog.error &&
    options.length,
  );
  const presets = [...new Set([0, 500, 1000, policy?.commissionBps ?? 0])].filter(
    (value) => value <= (policy?.commissionBps ?? 0),
  );
  const edit = (action: () => void) => {
    action();
    setKey(randomUUID());
  };
  useEffect(() => {
    dialog.current?.focus();
  }, [step, dialog]);
  return (
    <Modal
      isOpen
      onClose={onClose}
      closable={!mutation.busy}
      showCloseButton={false}
      width={step === 1 ? "520px" : "1440px"}
      maxWidth="calc(100vw - 32px)"
      maxHeight="90dvh"
      overflow="hidden"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-col outline-none"
      >
        <form
          className="flex max-h-[90dvh] min-h-0 flex-col"
          onSubmit={async (e) => {
            e.preventDefault();
            if (step === 1) {
              if (discountValid) setStep(2);
              return;
            }
            if (!valid || !policy || bps === null || (expires && +new Date(expiry) <= Date.now()))
              return;
            if (
              await mutation.execute(() =>
                affiliateRequest("createOffer", {
                  policyId,
                  name: name.trim(),
                  discountBps: bps,
                  planId: policy.planId ?? null,
                  eligiblePlans: selection,
                  ...(expires ? { expiresAt: new Date(expiry).toISOString() } : {}),
                  idempotencyKey: key,
                }),
              )
            )
              onCreated();
          }}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 px-6 pb-5 pt-6">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                {copy.create} · {step} / 2
              </p>
              <h2 id={`${id}-title`} className="text-xl font-medium">
                {step === 1 ? copy.chooseDiscount : copy.choosePlans}
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {step === 1 ? copy.createHint : copy.choosePlansHint}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.close}
              disabled={mutation.busy}
              onClick={onClose}
            >
              <Icon name="close" size="18" />
            </Button>
          </header>
          <div className="@container/link-review min-h-0 overflow-y-auto px-5 pb-6 sm:px-6">
            {step === 1 ? (
              <fieldset disabled={mutation.busy} className="space-y-5">
                {data.program.policies.length > 1 && (
                  <div className="space-y-2 text-sm">
                    <label htmlFor={`${id}-policy`}>{copy.policy}</label>
                    <CustomSelect
                      id={`${id}-policy`}
                      aria-label={copy.policy}
                      variant="filled"
                      triggerClassName="bg-muted/60 hover:bg-muted"
                      value={policyId}
                      onChange={(value) =>
                        edit(() => {
                          setPolicy(value);
                          setDiscount("0");
                          setSelection(null);
                        })
                      }
                      options={data.program.policies.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </div>
                )}
                <div className="space-y-3">
                  <label htmlFor={`${id}-discount`} className="text-sm">
                    {copy.discount}
                  </label>
                  <div className="relative">
                    <Input
                      id={`${id}-discount`}
                      variant="filled"
                      className="bg-muted/60 pe-9"
                      inputMode="decimal"
                      value={discount}
                      onChange={(e) => edit(() => setDiscount(e.target.value))}
                      aria-invalid={!discountValid}
                      aria-describedby={`${id}-discount-hint`}
                    />
                    <span className="pointer-events-none absolute inset-y-0 end-3.5 flex items-center text-sm text-muted-foreground">
                      %
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((value) => (
                      <Button
                        key={value}
                        type="button"
                        size="sm"
                        variant={bps === value ? "secondary" : "ghost"}
                        aria-pressed={bps === value}
                        onClick={() => edit(() => setDiscount(String(value / 100)))}
                      >
                        {value === 0 ? copy.noDiscount : `${value / 100}%`}
                      </Button>
                    ))}
                  </div>
                  <p
                    id={`${id}-discount-hint`}
                    className={`text-xs leading-relaxed ${discountValid ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {discountValid
                      ? copy.budgetHint
                      : copy.discountInvalid.replace(
                          "{percent}",
                          String((policy?.commissionBps ?? 0) / 100),
                        )}
                  </p>
                </div>
                <div className="flex items-end justify-between gap-4 rounded-2xl bg-card p-5">
                  <div>
                    <p className="text-sm text-muted-foreground">{copy.yourCommission}</p>
                    <p className="mt-2 text-3xl font-medium tabular-nums">
                      {discountValid ? (policy!.commissionBps - bps!) / 100 + "%" : "—"}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {policy?.durationMonths} {copy.months}
                  </p>
                </div>
              </fieldset>
            ) : (
              <div className="grid items-start gap-6 @min-[1120px]/link-review:grid-cols-[minmax(0,1fr)_272px]">
                <div className="min-w-0 space-y-4">
                  {catalog.loading ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      {copy.loading}
                    </p>
                  ) : catalog.error ? (
                    <div className="space-y-3">
                      <p role="alert" className="text-sm text-destructive">
                        {catalog.error}
                      </p>
                      <Button type="button" variant="secondary" onClick={catalog.retry}>
                        {copy.retry}
                      </Button>
                    </div>
                  ) : options.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{copy.referralNoPlans}</p>
                  ) : (
                    <AffiliatePlanPicker
                      options={options}
                      selection={selection}
                      onChange={(value) => edit(() => setSelection(value))}
                      commissionBps={policy?.commissionBps ?? 0}
                      discountBps={bps ?? 0}
                      durationMonths={policy?.durationMonths ?? 0}
                      disabled={mutation.busy}
                    />
                  )}
                  {!selectionValid && Boolean(selection?.length) && (
                    <p role="alert" className="text-sm text-destructive">
                      {copy.selectionChanged}
                    </p>
                  )}
                </div>
                <aside className="order-first min-w-0 space-y-4 rounded-2xl bg-card p-4 @min-[1120px]/link-review:order-last @min-[1120px]/link-review:space-y-5 @min-[1120px]/link-review:p-5">
                  <label className="block space-y-2 text-sm">
                    <span className="font-medium">{copy.linkName}</span>
                    <Input
                      variant="filled"
                      value={name}
                      maxLength={100}
                      placeholder={copy.linkNamePlaceholder}
                      required
                      disabled={mutation.busy}
                      onChange={(e) => edit(() => setName(e.target.value))}
                    />
                  </label>
                  <dl className="grid grid-cols-3 gap-3 text-xs @min-[1120px]/link-review:grid-cols-1 @min-[1120px]/link-review:text-sm">
                    <div className="flex flex-col justify-between gap-1 @min-[1120px]/link-review:flex-row @min-[1120px]/link-review:items-baseline @min-[1120px]/link-review:gap-3">
                      <dt className="text-muted-foreground">{copy.discount}</dt>
                      <dd className="font-medium tabular-nums">
                        {bps === null ? "—" : bps / 100 + "%"}
                      </dd>
                    </div>
                    <div className="flex flex-col justify-between gap-1 @min-[1120px]/link-review:flex-row @min-[1120px]/link-review:items-baseline @min-[1120px]/link-review:gap-3">
                      <dt className="text-muted-foreground">{copy.yourCommission}</dt>
                      <dd className="font-medium tabular-nums">
                        {discountValid ? (policy!.commissionBps - bps!) / 100 + "%" : "—"}
                      </dd>
                    </div>
                    <div className="flex flex-col justify-between gap-1 @min-[1120px]/link-review:flex-row @min-[1120px]/link-review:items-baseline @min-[1120px]/link-review:gap-3">
                      <dt className="text-muted-foreground">{copy.rewardDuration}</dt>
                      <dd className="whitespace-nowrap">
                        {policy?.durationMonths} {copy.months}
                      </dd>
                    </div>
                  </dl>
                  <div className="space-y-3 border-t border-border/30 pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm">{copy.setExpiry}</span>
                      <Switch
                        checked={expires}
                        onChange={(value) => edit(() => setExpires(value))}
                        disabled={mutation.busy}
                        ariaLabel={copy.setExpiry}
                      />
                    </div>
                    {expires ? (
                      <label className="block">
                        <span className="sr-only">{copy.expiry}</span>
                        <Input
                          variant="filled"
                          type="datetime-local"
                          value={expiry}
                          required
                          disabled={mutation.busy}
                          onChange={(e) => edit(() => setExpiry(e.target.value))}
                          aria-invalid={Boolean(expiry) && !expiryValid}
                        />
                      </label>
                    ) : (
                      <p className="hidden text-xs text-muted-foreground @min-[1120px]/link-review:block">
                        {copy.noExpiry}
                      </p>
                    )}
                    {expires && (
                      <p
                        className={`text-xs leading-relaxed ${expiry && !expiryValid ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {expiry && !expiryValid ? copy.expiryInvalid : copy.expiryHint}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                    <p>
                      {copy.earningWindow.replace("{months}", String(policy?.durationMonths ?? 0))}
                    </p>
                    {policy &&
                      policy.durationMonths <= 12 &&
                      options.some((option) => option.interval === "annual") &&
                      (selection === null ||
                        selection.some((item) => item.intervals.includes("annual"))) && (
                        <p>
                          {copy.annualFirstPaymentHint.replace(
                            "{months}",
                            String(policy.durationMonths),
                          )}
                        </p>
                      )}
                  </div>
                </aside>
              </div>
            )}
          </div>
          <footer className="shrink-0 space-y-3 border-t border-border/30 px-6 py-4">
            {mutation.error && (
              <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
                {mutation.error}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <Button
                variant="ghost"
                type="button"
                disabled={mutation.busy}
                onClick={() => (step === 1 ? onClose() : setStep(1))}
              >
                {step === 1 ? copy.cancel : copy.previous}
              </Button>
              <Button
                type="submit"
                disabled={mutation.busy || (step === 1 ? !discountValid : !valid)}
              >
                {step === 1 ? copy.next : copy.create}
                <Icon name="arrow-right" size="16" />
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </Modal>
  );
}
