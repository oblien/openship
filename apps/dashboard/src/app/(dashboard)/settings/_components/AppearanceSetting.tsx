"use client";

import { useId } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { useTheme } from "@/components/theme-provider";
import { SettingsSection } from "./SettingsSection";

const THEMES = ["light", "dim", "dark", "system"] as const;

export function AppearanceSetting() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const copy = t.settings.appearance;
  const groupName = useId();

  return (
    <SettingsSection icon="sun-moon" title={copy.title} description={copy.description}>
      <div className="@container">
        <fieldset className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <legend className="sr-only">{copy.title}</legend>
          {THEMES.map((value) => {
            const selected = theme === value;
            return (
              <label key={value} className="min-w-0 cursor-pointer">
                <input
                  type="radio"
                  name={groupName}
                  value={value}
                  checked={selected}
                  onChange={() => setTheme(value)}
                  className="peer sr-only"
                />
                <div className={`rounded-xl p-2.5 transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 ${
                  selected ? "bg-foreground/[0.08]" : "bg-muted/30 hover:bg-foreground/[0.04]"
                }`}>
                  {value === "system" ? (
                    <div className="relative overflow-hidden rounded-lg" aria-hidden="true">
                      <ThemePreview theme="light" />
                      <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                        <ThemePreview theme="dark" />
                      </div>
                    </div>
                  ) : (
                    <ThemePreview theme={value} />
                  )}
                  <div className="mt-3 flex min-w-0 items-center justify-between gap-2 px-1 text-sm font-medium text-foreground">
                    <span>{copy.themes[value]}</span>
                    <UiIcon name="check" className={`size-4 shrink-0 ${selected ? "visible" : "invisible"}`} />
                  </div>
                </div>
              </label>
            );
          })}
        </fieldset>
      </div>
    </SettingsSection>
  );
}

/** Miniature layout using each theme's own tokens, independent of the active theme. */
function ThemePreview({ theme }: { theme: "light" | "dim" | "dark" }) {
  return (
    <div data-theme={theme} aria-hidden="true" className="flex h-24 gap-2 overflow-hidden rounded-lg bg-[var(--th-bg-page)] p-2.5">
      <div className="flex w-1/4 shrink-0 flex-col gap-1.5 rounded-md bg-[var(--th-card-bg)] p-1.5">
        <span className="mb-1 size-2 shrink-0 rounded-full bg-[var(--th-text-title)]" />
        <span className="h-1.5 rounded-full bg-[var(--th-on-20)]" />
        <span className="h-1 w-3/4 rounded-full bg-[var(--th-on-10)]" />
        <span className="h-1 w-3/4 rounded-full bg-[var(--th-on-10)]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
        <span className="h-1.5 w-3/5 shrink-0 rounded-full bg-[var(--th-on-40)]" />
        <div className="grid flex-1 grid-cols-2 gap-1.5">
          <span className="rounded-md bg-[var(--th-card-bg)]" />
          <span className="rounded-md bg-[var(--th-card-bg)]" />
        </div>
        <span className="h-4 shrink-0 rounded-md bg-[var(--th-card-bg)]" />
      </div>
    </div>
  );
}
