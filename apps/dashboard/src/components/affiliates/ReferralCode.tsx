"use client";
import { useCallback, useEffect, useState } from "react";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getReferralOffer } from "@/lib/api/affiliates";

export function useReferralCode(initial?: string) {
  const [code, updateCode] = useState(initial ?? "");
  const setCode = (value: string) => {
    updateCode(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("ref", value);
    else url.searchParams.delete("ref");
    window.history.replaceState(window.history.state, "", url);
  };
  useEffect(() => {
    updateCode(initial ?? "");
  }, [initial]);
  const fetcher = useCallback(
    () => (code ? getReferralOffer(code) : Promise.resolve(null)),
    [code],
  );
  const state = useScopedResource(fetcher);
  return {
    code,
    setCode,
    state,
    ready: !code || (!state.loading && !state.error && !!state.data),
    verified: !state.error && state.data?.code === code ? code : undefined,
  };
}
export function ReferralCode({
  referral,
  disabled,
}: {
  referral: ReturnType<typeof useReferralCode>;
  disabled: boolean;
}) {
  const { t } = useI18n(),
    copy = t.affiliates;
  const [draft, setDraft] = useState(referral.code);
  if (referral.code)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4 text-sm">
        <div>
          <p className="font-medium">
            {copy.code}: {referral.code}
          </p>
          <p
            role={referral.state.error ? "alert" : "status"}
            className="mt-1 text-xs text-muted-foreground"
          >
            {referral.state.loading
              ? copy.verifying
              : (referral.state.error ??
                (referral.state.data
                  ? `${copy.discount}: ${referral.state.data.discountBps / 100}% · ${referral.state.data.durationMonths} ${copy.months}`
                  : copy.referralUnavailable))}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            referral.setCode("");
            setDraft("");
          }}
        >
          {copy.remove}
        </Button>
      </div>
    );
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="w-fit cursor-pointer py-2">{copy.code}</summary>
      <div className="mt-2 flex max-w-md gap-2">
        <Input
          variant="filled"
          aria-label={copy.code}
          value={draft}
          disabled={disabled}
          maxLength={63}
          onChange={(e) => setDraft(e.target.value.toUpperCase().trim())}
        />
        <Button
          variant="secondary"
          disabled={disabled || !/^AF-[A-Z0-9][A-Z0-9-]{5,59}$/.test(draft)}
          onClick={() => referral.setCode(draft)}
        >
          {copy.apply}
        </Button>
      </div>
    </details>
  );
}
