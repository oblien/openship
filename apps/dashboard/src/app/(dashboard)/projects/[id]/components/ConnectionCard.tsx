"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Eye, EyeOff, Loader2, Link2, MonitorSmartphone, PlugZap } from "lucide-react";
import { hasUnresolvedPlaceholder, resolveLocalized } from "@repo/core";
import { appsApi, type AppConnectionOutput, type AppConnectionView } from "@/lib/api/apps";
import { useI18n } from "@/components/i18n-provider";
import { useLocalhostForward } from "@/hooks/useLocalhostForward";
import { UseInProjectModal } from "./UseInProjectModal";

/**
 * Drop any value that still carries a template placeholder. The API resolves
 * these against the project's real routes and blanks what it can't resolve, so
 * this is the second line: an older/other API build once sent the literal
 * `{{publicUrl:backend:3210}}` and the card rendered it as the deployment URL —
 * and the same values feed the "Use in a project" injection. Blanking here makes
 * it show the muted "—" (not routed yet) and drop out of the handover.
 */
function sanitizeOutput(output: AppConnectionOutput): AppConnectionOutput {
  const clean = (value: string) => (hasUnresolvedPlaceholder(value) ? "" : value);
  return {
    ...output,
    value: clean(output.value),
    ...(output.variants
      ? { variants: output.variants.map((v) => ({ ...v, value: clean(v.value) })) }
      : {}),
  };
}

/**
 * Whether forwarding this value ends in a browser tab or on the clipboard. A web
 * admin (`http://host:8081`) opens; a driver URL (`mongodb://…`) has nowhere to
 * open, so the forwarded address is copied instead. Shared with the button label
 * so the two can't drift into promising "Open" and then silently copying.
 */
function opensInBrowser(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Port from an `http(s)://host:port` or `scheme://…@host:port/…` value, if any. */
function portOf(value: string): number | null {
  try {
    const p = new URL(value).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/**
 * Connection card — surfaces a project's connection details (public URL and
 * generated keys, or its internal service address) so the user copies them into
 * the app / client SDK rather than shelling in. Everything comes pre-resolved from
 * one authoritative endpoint (`GET /projects/:id/app-connection`):
 *   - a catalog app whose template declares a `connection` block gets a curated
 *     view (env from the backing services, `publicUrl` → assigned domain/host:port);
 *   - any other project (plain app / raw compose / monorepo, no template) gets a
 *     synthesized view of its internal address(es) — `http://<alias>:<port>` per
 *     reachable service, the same alias its containers answer to on the shared
 *     network. This is what makes a plain app a valid "Use in a project" source.
 * A project with nothing reachable (no port anywhere) returns no outputs and the
 * card renders nothing.
 *
 * Desktop + a remote-server app: each host:port value gets an "Open on localhost"
 * action that forwards the remote port to this machine over the existing SSH
 * tunnel (never shown on a VPS/cloud, which are already reachable directly).
 */
export function ConnectionCard({
  projectId,
  appTemplateId,
  serverId,
  deployTarget,
}: {
  projectId: string;
  appTemplateId?: string | null;
  serverId?: string | null;
  deployTarget?: string | null;
}) {
  const [view, setView] = useState<AppConnectionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const { t, locale } = useI18n();
  // Shared tunnel-forward: `canForward` gates each host:port value's "Open on
  // localhost" action (desktop dashboard managing a remote server only).
  const { canForward, forward } = useLocalhostForward({ serverId, deployTarget });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await appsApi.getConnection(projectId).catch(() => null);
        const data = res?.data;
        if (!cancelled) {
          setView(data ? { ...data, outputs: data.outputs.map(sanitizeOutput) } : { outputs: [] });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Forward a connection value's port to localhost. A web admin URL opens in a
   * tab; a driver URL (`mongodb://…`) has nowhere to open, so its forwarded
   * address is copied instead. The tunnel plumbing itself lives in the hook.
   */
  const forwardValue = (value: string) => {
    const port = portOf(value);
    if (!port) return;
    return forward(port, opensInBrowser(value) ? "open" : "copy");
  };

  // Nothing to show until the view resolves; render only when it has outputs.
  if (loading) return <ConnectionCardSkeleton />;
  if (!view || view.outputs.length === 0) return null;

  const injectable = view.outputs.filter((o) => o.value);
  const c = t.projects.connections;
  // A synthesized (non-template) view carries no title/description — it's a plain
  // app / raw compose surfaced as an internal source. Fall back to localized
  // "internal address" copy in that case; a template view keeps its own strings.
  const title = view.title ?? c.internalTitle;
  const description = view.description ?? (view.title ? undefined : c.internalDescription);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="mb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          </div>
          {injectable.length > 0 && (
            <button
              type="button"
              onClick={() => setLinkOpen(true)}
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
            >
              <PlugZap className="size-4" /> {c.useInProject}
            </button>
          )}
        </div>
        {description && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {/* Columns: `half`-width outputs pair on one line once there's room for two
          44px fields side by side; below that everything stacks full width. */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        {view.outputs.map((o) => (
          <div
            key={o.id}
            className={`min-w-0 ${o.width === "half" ? "sm:col-span-1" : "sm:col-span-2"}`}
          >
            <OutputRow output={o} locale={locale} onForward={canForward ? forwardValue : undefined} />
          </div>
        ))}
      </div>

      {linkOpen && (
        <UseInProjectModal
          open={linkOpen}
          onClose={() => setLinkOpen(false)}
          sourceProjectId={projectId}
          sourceAppTemplateId={appTemplateId}
          outputs={injectable}
          guide={view.guide}
        />
      )}
    </div>
  );
}

/**
 * Loading shell — the card's own surface with solid blocks where the title and
 * the first fields go, so the panel doesn't flash an empty titled card while the
 * one connection request is in flight.
 */
function ConnectionCardSkeleton() {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="h-5 w-44 animate-pulse rounded-lg bg-muted" />
      <div className="mt-2 h-3.5 w-2/3 animate-pulse rounded bg-muted" />
      <div className="mt-5 space-y-5">
        <div className="h-11 animate-pulse rounded-xl bg-muted" />
        <div className="h-11 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}

function OutputRow({
  output,
  onForward,
  locale,
}: {
  output: AppConnectionOutput;
  onForward?: (value: string) => void | Promise<unknown>;
  locale?: string;
}) {
  const { t } = useI18n();
  const c = t.projects.connections;
  // A multi-value output renders a switch over [primary, …variants]; the selected
  // entry drives the shown/masked value + reveal + copy + forward. No variants →
  // a single value (options=null), rendered exactly as before.
  const options =
    output.variants && output.variants.length > 0
      ? [
          { id: "__primary", label: resolveLocalized(output.sourceLabel, locale) || "Default", value: output.value },
          ...output.variants.map((v) => ({
            id: v.id,
            label: resolveLocalized(v.label, locale) || v.id,
            value: v.value,
          })),
        ]
      : null;
  const [sel, setSel] = useState(0);
  const value = options ? (options[sel]?.value ?? "") : output.value;

  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const masked = !!output.secret && !revealed;
  const canForwardThis = !!onForward && portOf(value) != null;
  // One word on the chip, the full phrase in the tooltip + accessible name. The
  // field is a value row: at "Open on localhost" width the action out-weighed the
  // URL it acts on, and on a `half` output it pushed the value to an ellipsis.
  const opensTab = opensInBrowser(value);
  const forwardText = opensTab ? c.openShort : c.forwardShort;
  const forwardLabel = opensTab ? c.openLocalhost : c.forwardLocalhost;
  // A `kind:"url"` output opens the ALREADY-PUBLIC value in a new tab — distinct
  // from the localhost forward (which tunnels a remote port to this machine).
  // Gated on a resolved http(s) value (hides on the "—" state) and excludes
  // synthesized internal east-west addresses, which aren't browser-reachable.
  const canOpen = output.kind === "url" && opensTab && !output.internal;
  const openInTab = () => window.open(value, "_blank", "noopener,noreferrer");

  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const doForward = async () => {
    if (!onForward) return;
    setForwarding(true);
    try {
      await onForward(value);
    } finally {
      setForwarding(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {output.label}
        </label>
        {/* Track + active fill follow the app's other segmented switches
            (ViewToggle, LevelSwitch): a bg-muted/50 track with the selected
            segment lifted off it. Those sit on the PAGE and lift to `bg-card`;
            this one is inside a card, where bg-card on bg-card is the same colour
            in dark/dim and the pill would vanish — so it lifts with the same 7%
            the sidebar's in-card active row uses. */}
        {options && (
          <div
            role="group"
            aria-label={output.label}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-xl bg-muted/50 p-0.5"
          >
            {options.map((opt, i) => {
              const active = i === sel;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setSel(i);
                    setCopied(false);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    active
                      ? "bg-foreground/[0.07] text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {/* 44px and rounded-xl like the shared <Input>, but a borderless lifted fill
          rather than that component's border + page-coloured inside. This is a
          read-only value, and a hairline around a fill this close to the card is
          the "outline around a hollow middle" the card surfaces dropped (see the
          card rules in globals.css) — same reason DnsRecordField and EnvKeyField
          draw their value chips as plain bg-muted. The fill is also what the
          actions inside it hover ABOVE, which a transparent field can't offer. */}
      <div className="mt-2 flex min-h-11 items-center gap-0.5 rounded-xl bg-muted py-1 pe-1 ps-3.5">
        {value ? (
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
            {masked ? "•".repeat(Math.min(value.length, 40)) : value}
          </code>
        ) : (
          <span className="min-w-0 flex-1 text-[13px] text-muted-foreground/50">—</span>
        )}
        {/* First in the run so it sits directly to the right of the URL. Opens
            the public value itself (no tunnel), so it's offered anywhere the URL
            is routed — unlike the desktop-only localhost forward below. */}
        {canOpen && value && (
          <FieldAction onClick={openInTab} label={c.openUrl} text={c.openShort}>
            <ExternalLink className="size-4" />
          </FieldAction>
        )}
        {/* Labelled, not a bare glyph: port-forwarding a remote service onto this
            machine is not something anyone guesses from an icon, and it's the one
            action here that reaches out and does something rather than reading. */}
        {canForwardThis && value && (
          <FieldAction onClick={doForward} disabled={forwarding} label={forwardLabel} text={forwardText}>
            {forwarding ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MonitorSmartphone className="size-4" />
            )}
          </FieldAction>
        )}
        {output.secret && value && (
          <FieldAction onClick={() => setRevealed((r) => !r)} label={revealed ? c.hide : c.reveal}>
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </FieldAction>
        )}
        {value && (
          <FieldAction onClick={copy} label={copied ? c.copied : c.copy}>
            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          </FieldAction>
        )}
      </div>
      {output.help && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">{output.help}</p>
      )}
    </div>
  );
}

/**
 * One action inside a value field, 36px tall to fill the 44px field (4px of
 * padding either side) instead of the bare 14px glyph it used to be.
 *
 * `text` promotes it to a labelled button with its own fill — for an action whose
 * icon can't carry the meaning on its own. Reveal and copy stay icon-only:
 * they're conventional, and three labelled buttons would leave no room for the
 * value.
 *
 * `label` is always the FULL phrase and `text` may be an abbreviation of it, so a
 * labelled button still takes `aria-label` when the two differ — "Open" alone
 * doesn't say where. aria-label REPLACES the text content for a screen reader
 * rather than adding to it, so there's no double announcement; it's dropped when
 * the text already is the label, which is the case that would be redundant.
 */
function FieldAction({
  onClick,
  label,
  text,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  text?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  // Built as one string per branch on purpose: two competing text-* / bg-*
  // utilities in the same className resolve by stylesheet order, not by the
  // order written here, so a shared base plus an override is a coin flip.
  //
  // Fills step ABOVE the field's own bg-muted (4% — the --th-sf-04 token) rather
  // than sitting at it: an action tinted the same as the surface it's on has no
  // edge to read. 8% is the top of that surface scale (--th-sf-08) and the page's
  // secondary buttons sit at 6% on the card, so this is the same step, one rung up
  // for the lighter surface — the old 10%/14% read as the brightest thing in the
  // card, brighter than "Use in a project" right above it.
  const shape = text
    ? "gap-1.5 bg-foreground/[0.08] px-2.5 text-[12px] font-medium text-foreground hover:bg-foreground/[0.12]"
    : "w-9 text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={!text || text !== label ? label : undefined}
      title={label}
      className={`flex h-9 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${shape}`}
    >
      {children}
      {text && <span className="whitespace-nowrap">{text}</span>}
    </button>
  );
}
