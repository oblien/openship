"use client";
import { useId, useMemo, useState } from "react";
import { Value } from "@sinclair/typebox/value";
import { countries } from "country-flag-icons";
import {
  AffiliatePayoutDestinationSchema,
  type AffiliatePayoutDestination,
  type AffiliatePayoutDestinationSummary,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { affiliateRequest } from "@/lib/api/affiliates";
import { PayoutMethodIcon, payoutMethods, payoutMethodHints } from "./PayoutMethodIcon";
export function PayoutDestinationForm({
  current,
  onClose,
  onSaved,
}: {
  current?: AffiliatePayoutDestinationSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n(),
    copy = t.affiliates;
  const mutation = useScopedMutation(),
    id = useId();
  const { dialog, onKeyDown } = useDialogFocus(() => {
    if (!mutation.busy) onClose();
  });
  const [method, setMethod] = useState<AffiliatePayoutDestination["method"]>(
    current?.method ?? "paypal",
  );
  const [accountName, setName] = useState(current?.accountName ?? "");
  const [identifier, setIdentifier] = useState(""),
    [country, setCountry] = useState(current?.country ?? "");
  const [bankName, setBank] = useState(""),
    [accountNumber, setAccount] = useState(""),
    [bankCode, setCode] = useState("");
  const [beneficiaryAddress, setAddress] = useState(""),
    [bankAddress, setBankAddress] = useState("");
  const countryOptions = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return countries
      .filter((code) => /^[A-Z]{2}$/.test(code) && !["EU", "UN"].includes(code))
      .map((code) => ({ value: code, label: names.of(code) ?? code }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);
  const destination =
    method === "bank_transfer"
      ? {
          method,
          accountName: accountName.trim(),
          country,
          bankName: bankName.trim(),
          accountNumber: accountNumber.trim(),
          bankCode: bankCode.trim(),
          beneficiaryAddress: beneficiaryAddress.trim(),
          ...(bankAddress.trim() ? { bankAddress: bankAddress.trim() } : {}),
        }
      : { method, accountName: accountName.trim(), identifier: identifier.trim() };
  const valid = Value.Check(AffiliatePayoutDestinationSchema, destination);
  const field = (
    label: string,
    value: string,
    change: (value: string) => void,
    maxLength: number,
    autoComplete = "off",
  ) => (
    <label className="block space-y-2 text-sm">
      <span>{label}</span>
      <Input
        variant="filled"
        value={value}
        onChange={(e) => change(e.target.value)}
        maxLength={maxLength}
        autoComplete={autoComplete}
        required
      />
    </label>
  );
  return (
    <Modal
      isOpen
      onClose={onClose}
      closable={!mutation.busy}
      showCloseButton={false}
      width="960px"
      maxWidth="calc(100vw - 32px)"
      maxHeight="90dvh"
      overflow="hidden"
      zIndex={10010}
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
            if (!valid) return;
            if (
              await mutation.execute(() =>
                affiliateRequest("setPayoutDestination", {
                  destination: destination as AffiliatePayoutDestination,
                }),
              )
            )
              onSaved();
          }}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 px-6 pb-5 pt-6">
            <div>
              <h2 id={`${id}-title`} className="text-xl font-medium">
                {copy.payoutAccount}
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{copy.payoutAccountHint}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.close}
              disabled={mutation.busy}
              onClick={onClose}
            >
              <Icon name="close" />
            </Button>
          </header>
          <div className="@container/payout-account min-h-0 overflow-y-auto px-5 pb-6 sm:px-6">
            <fieldset
              disabled={mutation.busy}
              className="grid items-start gap-6 @min-[760px]/payout-account:grid-cols-[240px_minmax(0,1fr)]"
            >
              <fieldset disabled={mutation.busy}>
                <legend className="mb-3 text-sm font-medium">{copy.payoutMethod}</legend>
                <div className="grid grid-cols-2 gap-2.5">
                  {payoutMethods.map((value) => (
                    <label key={value} className="relative cursor-pointer">
                      <input
                        type="radio"
                        name={`${id}-method`}
                        value={value}
                        checked={method === value}
                        onChange={() => setMethod(value)}
                        className="peer sr-only"
                      />
                      <span className="flex h-full flex-col items-start gap-3 rounded-xl bg-card p-3.5 transition-colors peer-checked:bg-muted peer-hover:bg-muted/70 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
                        <PayoutMethodIcon method={value} />
                        <span className="text-sm font-medium">{copy.payoutMethods[value]}</span>
                        <span
                          aria-hidden="true"
                          className={`absolute end-3.5 top-3.5 flex size-4 items-center justify-center rounded-full border ${method === value ? "border-foreground/60" : "border-border"}`}
                        >
                          {method === value && (
                            <span className="size-2 rounded-full bg-foreground" />
                          )}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                  {copy.manualPayoutHint}
                </p>
              </fieldset>
              <div className="space-y-5 rounded-2xl bg-card p-5">
                <div className="flex items-start gap-3">
                  <PayoutMethodIcon method={method} />
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{copy.payoutMethods[method]}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {copy[payoutMethodHints[method]]}
                    </p>
                  </div>
                </div>
                {field(copy.accountName, accountName, setName, 120, "name")}
                {method === "bank_transfer" ? (
                  <>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="space-y-2 text-sm">
                        <label htmlFor={`${id}-country`}>{copy.bankCountry}</label>
                        <CustomSelect
                          id={`${id}-country`}
                          aria-label={copy.bankCountry}
                          variant="filled"
                          triggerClassName="bg-muted/60 hover:bg-muted"
                          placeholder={copy.bankCountry}
                          value={country}
                          onChange={setCountry}
                          disabled={mutation.busy}
                          options={countryOptions}
                          searchable
                          searchPlaceholder={copy.bankCountry}
                        />
                      </div>
                      {field(copy.bankName, bankName, setBank, 120)}
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                      {field(copy.accountNumber, accountNumber, setAccount, 50)}
                      {field(copy.bankCode, bankCode, setCode, 40)}
                    </div>
                    {field(
                      copy.beneficiaryAddress,
                      beneficiaryAddress,
                      setAddress,
                      300,
                      "street-address",
                    )}
                    <label className="block space-y-2 text-sm">
                      <span>{copy.bankAddress}</span>
                      <Input
                        variant="filled"
                        value={bankAddress}
                        onChange={(e) => setBankAddress(e.target.value)}
                        maxLength={300}
                        autoComplete="off"
                      />
                    </label>
                  </>
                ) : (
                  field(
                    method === "paypal" ? copy.paypalIdentifier : copy.walletEmail,
                    identifier,
                    setIdentifier,
                    254,
                  )
                )}
              </div>
            </fieldset>
          </div>
          <footer className="shrink-0 space-y-3 border-t border-border/30 px-6 py-4">
            {mutation.error && (
              <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
                {mutation.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" disabled={mutation.busy} onClick={onClose}>
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={!valid || mutation.busy}>
                {copy.saveAccount}
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </Modal>
  );
}
