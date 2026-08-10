"use client";

import { LayoutGrid, List } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

export type ProjectView = "list" | "grid";

/**
 * List / grid segmented control. Labelled rather than icon-only — two abstract
 * glyphs side by side are a coin flip for anyone who hasn't used them before,
 * and there is room for the words here.
 *
 * A recessed track with a lifted active pill, which is the same
 * fill-does-the-work language the cards use now (see the card surface rules in
 * globals.css) — no borders anywhere.
 */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ProjectView;
  onChange: (v: ProjectView) => void;
}) {
  const { t } = useI18n();
  const copy = t.dashboard.pages.projects.view;

  const options: { id: ProjectView; label: string; Icon: typeof List }[] = [
    { id: "list", label: copy.list, Icon: List },
    { id: "grid", label: copy.grid, Icon: LayoutGrid },
  ];

  return (
    <div
      role="group"
      aria-label={copy.label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-xl bg-muted/50 p-1"
    >
      {options.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              active
                ? "bg-card text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default ViewToggle;
