"use client";

import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function BillingIntervalPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: "monthly" | "annual";
  onChange: (value: "monthly" | "annual") => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className="inline-flex gap-1 rounded-xl bg-muted/40 p-1"
      role="group"
      aria-label={t.billing.pricing.billingInterval}
    >
      {(["monthly", "annual"] as const).map((interval) => (
        <Button
          key={interval}
          type="button"
          size="sm"
          aria-pressed={value === interval}
          onClick={() => onChange(interval)}
          disabled={disabled}
          variant={value === interval ? "secondary" : "ghost"}
        >
          {interval === "monthly" ? t.billing.pricing.monthly : t.billing.pricing.annual}
        </Button>
      ))}
    </div>
  );
}
