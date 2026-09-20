"use client";

import { useId, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";

/** Confirmation belongs to the exact draft/plan and attempt, never to a whole session. */
export function useNetworkFirewallConfirmation(reviewKey: string) {
  const [accepted, setAccepted] = useState<string | null>(null);
  return {
    checked: accepted === reviewKey,
    onCheckedChange: (checked: boolean) => setAccepted(checked ? reviewKey : null),
  };
}

export function NetworkFirewallConfirmation({
  mode,
  checked,
  onCheckedChange,
  disabled,
}: {
  mode: "native" | "wireguard";
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const f = t.servers.networks.managed.firewallRules;
  const id = useId();
  return (
    <div className="space-y-2" role="group" aria-label={f.confirmTitle}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          className="mt-0.5"
        />
        <span>{mode === "native" ? f.confirmNative : f.confirmManaged}</span>
      </label>
      <p className="ps-7 text-xs leading-relaxed text-muted-foreground">{f.confirmHint}</p>
    </div>
  );
}
