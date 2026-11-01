"use client";

import { Icon } from "@repo/ui/icons";
import { OptionCard } from "@/components/shared/OptionCard";
import { useI18n } from "@/components/i18n-provider";

export function CloudStaticHosting({
  value,
  disabled,
  onChange,
}: {
  value: "pages" | "server";
  disabled?: boolean;
  onChange(value: "pages" | "server"): void;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.cloudStaticHosting;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
      <p className="text-sm text-muted-foreground">{copy.description}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["pages", "server"] as const).map((mode) => (
          <OptionCard
            key={mode}
            value={mode}
            selected={value === mode}
            disabled={disabled}
            onSelect={() => onChange(mode)}
            icon={<Icon name={mode === "pages" ? "cloud" : "server"} className="size-4" />}
            label={copy[mode]}
            description={copy[`${mode}Description`]}
          />
        ))}
      </div>
    </div>
  );
}
