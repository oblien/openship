"use client";

import { Switch } from "@/components/ui/Switch";

/**
 * One settings preference: label + description on the start side, switch on the
 * end. Shared by every settings tab that offers a boolean, so they line up and
 * behave identically — and so the switch itself stays the one in `ui/Switch`
 * (three tabs had each hand-rolled a copy, and the hardcoded white knob in those
 * copies was invisible in the dark themes).
 */
export function SettingsToggleRow({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        size="lg"
        ariaLabel={label}
        className="mt-0.5"
      />
    </div>
  );
}
