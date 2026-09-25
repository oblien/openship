"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * The primary control on the consent screen: pick a named permission template.
 *
 * Templates are STARTING POINTS, not modes — every one of them is editable below,
 * and editing relabels the selection "Custom" (see mcp-access-templates.relabel)
 * so the card set never claims a name the grants no longer match.
 */

import { TEMPLATE_ORDER, type AccessTemplateId } from "./mcp-access-templates";
import { useI18n, interpolate } from "@/components/i18n-provider";

const ICONS: Record<AccessTemplateId, IconName> = {
  agent: "bot",
  existing: "folder-code",
  readOnly: "eye",
  full: "shield-alert",
  custom: "sliders",
};

export function AccessTemplateCards({
  active,
  orgName,
  disabled,
  onPick,
  onReset,
}: {
  active: AccessTemplateId;
  orgName: string;
  disabled?: boolean;
  onPick: (id: AccessTemplateId) => void;
  /** Present only while `active === "custom"` — re-applies the safe default. */
  onReset: () => void;
}) {
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;

  const copy: Record<AccessTemplateId, { title: string; desc: string; badge?: string; tone?: "warning" }> = {
    agent: { title: m.tplAgentTitle, desc: m.tplAgentDesc, badge: m.recommendedBadge },
    existing: { title: m.tplExistingTitle, desc: m.tplExistingDesc },
    readOnly: { title: m.tplReadOnlyTitle, desc: interpolate(m.tplReadOnlyDesc, { org: orgName }) },
    full: {
      title: m.tplFullTitle,
      desc: interpolate(m.tplFullDesc, { org: orgName }),
      badge: m.broadBadge,
      tone: "warning",
    },
    custom: { title: m.tplCustomTitle, desc: m.tplCustomDesc },
  };

  return (
    <div className="rounded-2xl bg-card p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium text-foreground">{m.templatesHeading}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{m.templatesNote}</p>
        </div>
        {active === "custom" && (
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-50"
          >
            <UiIcon name="rotate-left" className="size-3.5" />
            {m.resetTemplate}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {TEMPLATE_ORDER.map((id) => (
          <TemplateCard
            key={id}
            icon={ICONS[id]}
            selected={active === id}
            disabled={disabled}
            onClick={() => onPick(id)}
            {...copy[id]}
          />
        ))}
      </div>

      {/* Custom is derived, so it gets a full-width row that only exists once the
          user has diverged — never an option they can pick into a blank slate. */}
      {active === "custom" && (
        <div className="mt-2.5">
          <TemplateCard icon={ICONS.custom} selected disabled={disabled} {...copy.custom} />
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  icon: Icon,
  title,
  desc,
  badge,
  tone,
  selected,
  disabled,
  onClick,
}: {
  icon: IconName;
  title: string;
  desc: string;
  badge?: string;
  tone?: "warning";
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const warn = tone === "warning";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-pressed={selected}
      className={`flex h-full w-full items-start gap-3 rounded-xl border p-3.5 text-start transition-all disabled:opacity-60 ${
        selected
          ? warn
            ? "border-warning-border bg-warning-bg"
            : "border-primary/50 bg-primary/[0.06] ring-1 ring-primary/20"
          : "border-border/50 hover:border-primary/30 hover:bg-primary/[0.02]"
      } ${onClick ? "" : "cursor-default"}`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
          selected
            ? warn
              ? "bg-warning/15 text-warning"
              : "bg-primary/15 text-primary"
            : "bg-muted/40 text-muted-foreground"
        }`}
      >
        <UiIcon name={Icon} className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`text-sm font-medium ${selected ? "text-foreground" : "text-foreground/80"}`}>
            {title}
          </span>
          {badge && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                warn ? "bg-warning/15 text-warning" : "bg-primary/15 text-primary"
              }`}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}
