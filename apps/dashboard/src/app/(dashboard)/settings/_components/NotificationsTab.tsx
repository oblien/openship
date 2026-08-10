"use client";

/**
 * NotificationsTab — full notification preferences UI.
 *
 * Three sections, each in its own card:
 *
 *   1. Channels — list / create / delete the user's delivery channels
 *      (email, webhook, slack, in-app). Channel configs are surfaced
 *      via a small inline form that switches shape per kind.
 *
 *   2. Subscriptions — one row per stable category, tabbed by the
 *      category groups the backend hands back (plus an "All" tab, which
 *      lists the same rows under one heading per group). Each row carries
 *      the org default and the caller's own "Notify me".
 *
 *   3. Org defaults — admin-only section to set per-category
 *      defaults that apply when a NEW member joins this org.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Mail, Webhook, MessageSquare, MessageCircle, MessagesSquare, Smartphone, Plus, Trash2, Loader2, AlertTriangle, Send, Check, ChevronDown, type LucideIcon } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { PillSwitcher } from "@/components/ui/PillSwitcher";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { systemApi } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import {
  notificationsApi,
  type NotificationCategory,
  type NotificationCategoryGroup,
  type NotificationChannel,
  type NotificationSubscription,
  type NotificationDefault,
  type ChannelKind,
} from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useI18n, interpolate } from "@/components/i18n-provider";

const CHANNEL_ICONS: Record<ChannelKind, LucideIcon> = {
  email: Mail,
  webhook: Webhook,
  slack: MessageSquare,
  discord: MessageCircle,
  msteams: MessagesSquare,
  telegram: Send,
  in_app: Smartphone,
};

/** Real brand mark per kind (simpleicons slug, brand-colored via AppLogo's CDN)
 *  — only the branded channels; generic kinds fall back to a lucide glyph. */
const CHANNEL_LOGOS: Partial<Record<ChannelKind, string>> = {
  slack: "slack",
  discord: "discord",
  msteams: "microsoftteams",
  telegram: "telegram",
};

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  email: "Email",
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
  msteams: "Microsoft Teams",
  telegram: "Telegram",
  in_app: "In-app",
};

/** Real brand logo where the channel has one (Slack/Discord/Teams via
 *  simpleicons through AppLogo), lucide glyphs for the generic kinds
 *  (email/webhook/in-app have no brand mark). */
function ChannelLogo({ kind, className = "size-4" }: { kind: ChannelKind; className?: string }) {
  const slug = CHANNEL_LOGOS[kind];
  if (slug) return <AppLogo slug={slug} icon={CHANNEL_ICONS[kind]} className={className} />;
  const Icon = CHANNEL_ICONS[kind];
  return <Icon className={`${className} text-foreground`} strokeWidth={1.7} />;
}

/** Channel kinds selectable as org-default destinations (in_app excluded — it's
 *  implicit, not a chosen destination). */
const DEFAULT_KIND_CHOICES: ChannelKind[] = [
  "email",
  "webhook",
  "slack",
  "discord",
  "msteams",
  "telegram",
];

/** Compact multi-select: pick one OR MORE channel kinds an event fans out to.
 *  Trigger shows the selected marks + count; a checklist popover toggles kinds.
 *  Always keeps ≥1 selected (unchecking the last is a no-op). */
function ChannelMultiSelect({
  value,
  disabled,
  onChange,
}: {
  value: ChannelKind[];
  disabled?: boolean;
  onChange: (kinds: ChannelKind[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (k: ChannelKind) => {
    const has = value.includes(k);
    if (has && value.length === 1) return; // keep at least one destination
    onChange(has ? value.filter((x) => x !== k) : [...value, k]);
  };

  return (
    <div ref={ref} className="relative flex justify-end">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/30 disabled:opacity-50"
      >
        <span className="flex items-center gap-1.5">
          <span className="flex -space-x-1">
            {value.slice(0, 2).map((k) => (
              <span
                key={k}
                className="grid size-5 place-items-center rounded-full bg-muted ring-1 ring-background"
              >
                <ChannelLogo kind={k} className="size-3" />
              </span>
            ))}
            {value.length > 2 && (
              <span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-1 ring-background">
                +{value.length - 2}
              </span>
            )}
          </span>
          <span className="whitespace-nowrap text-muted-foreground">
            {interpolate(t.settings.notifications.orgDefaults.nChannels, { n: String(value.length) })}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        // Frosted-glass surface (`bg-popover/70` color-mix + `backdrop-blur-xl`).
        // CRITICAL: the blur container is NEVER given an opacity animation — an
        // element with opacity < 1 stops rendering its own backdrop-filter, so a
        // `fade-in` here would flash the blur off on open. The container only
        // TRANSLATES in (blur-safe); the entrance FADE lives on the inner items
        // wrapper below (child opacity doesn't touch the parent's backdrop-filter).
        <div className="absolute end-0 z-50 mt-1 w-52 overflow-hidden rounded-xl border border-border/60 bg-popover/70 p-1 shadow-xl shadow-black/[0.08] backdrop-blur-xl animate-in slide-in-from-top-1 duration-150">
          <div className="animate-in fade-in duration-200">
            {DEFAULT_KIND_CHOICES.map((k) => {
              const on = value.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggle(k)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/50"
                >
                  <span
                    className={`grid size-4 shrink-0 place-items-center rounded border transition-colors ${
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                    }`}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <ChannelLogo kind={k} className="size-4" />
                  <span className="flex-1 text-start">{t.settings.notifications.kinds[k]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function NotificationsTab() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<NotificationCategory[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<NotificationCategoryGroup[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [subscriptions, setSubscriptions] = useState<NotificationSubscription[]>([]);
  const [defaults, setDefaults] = useState<NotificationDefault[]>([]);
  const [role, setRole] = useState<string | null>(null);

  const isAdmin = role === "owner" || role === "admin";

  // `silent` re-fetches without flipping the full-page `loading` flag — used after
  // a toggle/mutation so only the clicked control shows its pending state (its
  // own busy flag) instead of the whole tab collapsing to a centered spinner.
  // The global spinner is reserved for the very first load.
  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!silent) setLoading(true);
      try {
        const [cats, ch, subs, defs] = await Promise.all([
          notificationsApi.listCategories(),
          notificationsApi.listChannels(),
          notificationsApi.listSubscriptions(),
          notificationsApi.listDefaults().catch(() => ({ defaults: [] })),
        ]);
        setCategories(cats.categories);
        setCategoryGroups(cats.groups);
        setChannels(ch.channels);
        setSubscriptions(subs.subscriptions);
        setDefaults(defs.defaults);
      } catch (err) {
        showToast(getApiErrorMessage(err), "error", "Notifications");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Resolve caller's role in active org so we can gate the defaults UI.
  useEffect(() => {
    (async () => {
      try {
        const result = await (
          authClient as unknown as {
            organization: {
              getFullOrganization: () => Promise<{
                data?: { members?: Array<{ userId: string; role: string }>; id: string } | null;
              }>;
            };
          }
        ).organization.getFullOrganization();
        const session = await authClient.getSession();
        const userId = session.data?.user?.id;
        const me = result.data?.members?.find((m) => m.userId === userId);
        setRole(me?.role ?? null);
      } catch {
        setRole(null);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ChannelsCard channels={channels} onChange={() => refresh({ silent: true })} />
      <EventNotificationsCard
        categories={categories}
        groups={categoryGroups}
        channels={channels}
        subscriptions={subscriptions}
        defaults={defaults}
        isAdmin={isAdmin}
        onChange={() => refresh({ silent: true })}
      />
    </div>
  );
}

/* ─── Channels card ──────────────────────────────────────────────── */

function ChannelsCard({
  channels,
  onChange,
}: {
  channels: NotificationChannel[];
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm(t.settings.notifications.channels.confirmDelete)) return;
    try {
      await notificationsApi.deleteChannel(id);
      showToast(
        t.settings.notifications.channels.channelRemoved,
        "success",
        t.settings.common.toast.notifications,
      );
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    }
  };

  // Send a real test message through the channel's worker. On success the server
  // marks it verified (the dispatcher only delivers to verified channels), so we
  // re-pull to flip the badge; on failure we surface the provider's error.
  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      await notificationsApi.testChannel(id);
      showToast(t.settings.notifications.channels.testSent, "success", t.settings.common.toast.notifications);
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      setTesting(null);
    }
  };

  return (
    <SettingsSection
      icon={Bell}
      title={t.settings.notifications.channels.title}
      description={t.settings.notifications.channels.description}
      /* In the header, not under the list: the list grows, so a button below it
         walks further from the heading with every channel added, and the form it
         opens is what should hold the reader's attention once it is open — hence
         no second trigger while the form is up (it carries its own Cancel). */
      action={
        showForm ? null : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/50 text-sm hover:bg-foreground/[0.04] transition"
          >
            <Plus className="size-4" strokeWidth={1.7} />
            {t.settings.notifications.channels.addChannel}
          </button>
        )
      }
    >
      {showForm && (
        <div className="mb-4">
          <NewChannelForm
            onCancel={() => setShowForm(false)}
            onSaved={async () => {
              setShowForm(false);
              await onChange();
            }}
          />
        </div>
      )}

      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.settings.notifications.channels.empty}</p>
      ) : (
        <ul className="divide-y divide-border/40">
          {channels.map((ch) => (
            <li key={ch.id} className="flex items-center gap-3 py-3">
              <div className="size-9 rounded-lg bg-muted flex items-center justify-center">
                <ChannelLogo kind={ch.kind} className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{ch.label}</p>
                <p className="text-xs text-muted-foreground truncate">{describeChannel(ch, t.settings.notifications.describe)}</p>
              </div>
              <div className="flex items-center gap-2">
                {ch.verified ? (
                  <span className="text-[11px] uppercase tracking-wide text-success">{t.settings.notifications.channels.verified}</span>
                ) : ch.kind !== "in_app" ? (
                  <span className="text-[11px] uppercase tracking-wide text-warning">{t.settings.notifications.channels.unverified}</span>
                ) : null}
                {/* In-app has nothing to prove; everything else can send a test to
                    verify reachability (and flip the Unverified badge). */}
                {ch.kind !== "in_app" && (
                  <button
                    type="button"
                    onClick={() => handleTest(ch.id)}
                    disabled={testing === ch.id}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground transition disabled:opacity-50"
                  >
                    {testing === ch.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Send className="size-3.5" strokeWidth={1.7} />
                    )}
                    {t.settings.notifications.channels.sendTest}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(ch.id)}
                  className="p-1.5 rounded-md hover:bg-foreground/[0.04] text-muted-foreground hover:text-destructive transition"
                  aria-label={t.settings.notifications.channels.deleteChannel}
                >
                  <Trash2 className="size-4" strokeWidth={1.7} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function describeChannel(
  ch: NotificationChannel,
  labels: { slackWebhook: string; discordWebhook: string; msteamsWebhook: string; inApp: string },
): string {
  switch (ch.kind) {
    case "email":
      return String((ch.config as { address?: string }).address ?? "");
    case "webhook":
      return String((ch.config as { url?: string }).url ?? "");
    case "slack":
      return String(
        (ch.config as { channelName?: string | null }).channelName ?? labels.slackWebhook,
      );
    case "discord":
      return labels.discordWebhook;
    case "msteams":
      return labels.msteamsWebhook;
    case "telegram": {
      // Chat id (and topic) are the useful discriminator and aren't secret —
      // the bot token is what's masked. No label needed, they're raw ids.
      const cfg = ch.config as { chatId?: string; messageThreadId?: string | null };
      return cfg.messageThreadId ? `${cfg.chatId ?? ""} · #${cfg.messageThreadId}` : String(cfg.chatId ?? "");
    }
    case "in_app":
      return labels.inApp;
    default:
      return "";
  }
}

function NewChannelForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [kind, setKind] = useState<ChannelKind>("email");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [url, setUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);
  // Whether the instance can send email at all (instance SMTP / mail server /
  // env). null = unknown (not yet loaded, or no permission to read). When false
  // we nudge the operator to configure SMTP — email channels won't deliver.
  const [emailDeliverable, setEmailDeliverable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    systemApi
      .getEmailSettings()
      .then((r) => {
        if (!cancelled) setEmailDeliverable(!!r.deliverable);
      })
      .catch(() => {
        if (!cancelled) setEmailDeliverable(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    if (!label.trim()) {
      showToast(
        t.settings.notifications.form.labelRequired,
        "error",
        t.settings.common.toast.notifications,
      );
      return;
    }
    let config: Record<string, unknown> = {};
    if (kind === "email") config = { address: address.trim() };
    else if (kind === "webhook") config = { url: url.trim() };
    else if (kind === "slack" || kind === "discord" || kind === "msteams")
      config = { webhookUrl: webhookUrl.trim() };
    else if (kind === "telegram")
      config = { botToken: botToken.trim(), chatId: chatId.trim() };

    setBusy(true);
    try {
      await notificationsApi.createChannel({ kind, label: label.trim(), config });
      showToast(
        t.settings.notifications.channels.channelAdded,
        "success",
        t.settings.common.toast.notifications,
      );
      await onSaved();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border/50 rounded-xl p-4 space-y-3">
      {/* Kind picker — one reusable switcher (real brand logos; scrolls with
          edge-fade + chevrons once the kinds outgrow the width). */}
      <PillSwitcher
        options={(
          ["email", "webhook", "slack", "discord", "msteams", "telegram"] as ChannelKind[]
        ).map((k) => ({
          value: k,
          label: t.settings.notifications.kinds[k],
          logo: CHANNEL_LOGOS[k],
          icon: CHANNEL_ICONS[k],
        }))}
        value={kind}
        onChange={setKind}
      />
      <input
        type="text"
        placeholder={t.settings.notifications.form.labelPlaceholder}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
      />

      {kind === "email" && (
        <input
          type="email"
          placeholder={t.settings.notifications.form.emailPlaceholder}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {kind === "email" && emailDeliverable === false && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.7} />
          <span>
            {t.settings.notifications.form.noEmailTransport}{" "}
            <Link
              href="/settings?tab=email"
              className="font-medium underline underline-offset-2 hover:opacity-80"
            >
              {t.settings.notifications.form.setUpSmtp}
            </Link>
          </span>
        </div>
      )}
      {kind === "webhook" && (
        <input
          type="url"
          placeholder={t.settings.notifications.form.webhookPlaceholder}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {kind === "slack" && (
        <input
          type="url"
          placeholder={t.settings.notifications.form.slackPlaceholder}
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {kind === "discord" && (
        <input
          type="url"
          placeholder={t.settings.notifications.form.discordPlaceholder}
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {kind === "msteams" && (
        <input
          type="url"
          placeholder={t.settings.notifications.form.msteamsPlaceholder}
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {/* The only kind needing two inputs: a bot identity plus a destination. */}
      {kind === "telegram" && (
        <>
          <input
            type="password"
            autoComplete="off"
            placeholder={t.settings.notifications.form.telegramTokenPlaceholder}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder={t.settings.notifications.form.telegramChatPlaceholder}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.notifications.form.telegramHint}
          </p>
        </>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-foreground text-background text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
        >
          {busy ? t.settings.notifications.form.adding : t.settings.notifications.form.addChannel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-foreground/[0.04] transition"
        >
          {t.settings.common.cancel}
        </button>
      </div>
    </div>
  );
}

/* ─── Event notifications card (org defaults + per-user opt-in, tabbed) ─── */

const ALL_TAB = "all";

function EventNotificationsCard({
  categories,
  groups,
  channels,
  subscriptions,
  defaults,
  isAdmin,
  onChange,
}: {
  categories: NotificationCategory[];
  groups: NotificationCategoryGroup[];
  channels: NotificationChannel[];
  subscriptions: NotificationSubscription[];
  defaults: NotificationDefault[];
  isAdmin: boolean;
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [busyCat, setBusyCat] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(ALL_TAB);

  // Counts are how many events live in the tab, NOT how many you're subscribed
  // to — they're a table of contents, so they stay put while you toggle rows.
  // A group with nothing in it is hidden rather than shown as "0": the server
  // omits whole groups it can't deliver (billing outside cloud), and an empty
  // tab reads like a bug.
  const tabs = useMemo<TabDef[]>(() => {
    const byGroup = new Map<string, number>();
    for (const cat of categories) byGroup.set(cat.group, (byGroup.get(cat.group) ?? 0) + 1);
    return [
      {
        key: ALL_TAB,
        label: t.settings.notifications.subscriptions.allTab,
        count: categories.length,
      },
      ...groups.map((g) => ({
        key: g.id,
        label: g.label,
        count: byGroup.get(g.id) ?? 0,
        hidden: !byGroup.has(g.id),
      })),
    ];
  }, [categories, groups, t]);

  /**
   * The rows, in the order they render, cut into sections.
   *
   * On "All" each group gets ONE heading with its events under it, rather than every
   * row repeating its group as a chip — 19 chips is 19 things to read to learn the
   * same 7 facts. On a group tab the heading would just repeat the tab you're standing
   * on, so that's a single unlabelled section.
   *
   * A category whose group the backend didn't send still renders, in a trailing
   * unlabelled section: dropping the row would hide a subscription the dispatcher
   * delivers on regardless.
   */
  const sections = useMemo<
    { id: string; label: string | null; cats: NotificationCategory[] }[]
  >(() => {
    if (tab !== ALL_TAB) {
      return [{ id: tab, label: null, cats: categories.filter((cat) => cat.group === tab) }];
    }
    const out = groups
      .map((g) => ({
        id: g.id,
        label: g.label as string | null,
        cats: categories.filter((cat) => cat.group === g.id),
      }))
      .filter((s) => s.cats.length > 0);
    const known = new Set(groups.map((g) => g.id));
    const rest = categories.filter((cat) => !known.has(cat.group));
    if (rest.length > 0) out.push({ id: "__ungrouped__", label: null, cats: rest });
    return out;
  }, [categories, groups, tab]);

  const defIndex = useMemo(() => {
    const m = new Map<string, NotificationDefault>();
    for (const d of defaults) m.set(d.category, d);
    return m;
  }, [defaults]);

  // Per-user "Notify me" resolves in two layers:
  //   • enabledCats — categories the caller has an ENABLED subscription on
  //     (any of their channels). Explicit opt-in.
  //   • rowCats     — categories the caller has ANY subscription row for
  //     (enabled or disabled). "Has made an explicit choice" — used to tell an
  //     untouched default (checkbox follows the org/category default) apart
  //     from a deliberate opt-out (a disabled row).
  // The dispatcher mirrors this: default-enabled categories notify members who
  // haven't touched them, so an important event (deploy failed, backup failed,
  // job failed…) shows checked and actually delivers without a manual opt-in.
  const enabledCats = useMemo(() => {
    const s = new Set<string>();
    for (const sub of subscriptions) if (sub.enabled) s.add(sub.category);
    return s;
  }, [subscriptions]);
  const rowCats = useMemo(() => {
    const s = new Set<string>();
    for (const sub of subscriptions) s.add(sub.category);
    return s;
  }, [subscriptions]);

  // Admin: the org default (channel kinds + on/off) applied when a member joins.
  const setDefault = async (category: string, enabled: boolean, kinds: ChannelKind[]) => {
    setBusyCat(category);
    try {
      await notificationsApi.upsertDefault({
        category,
        defaultEnabled: enabled,
        defaultChannelKinds: kinds,
      });
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      setBusyCat(null);
    }
  };

  // Per-user: one checkbox toggles the subscription across ALL the caller's
  // channels (the backend model is per-channel, so we fan the write out).
  const setNotifyMe = async (category: string, enabled: boolean) => {
    setBusyCat(category);
    try {
      await Promise.all(
        channels.map((ch) =>
          notificationsApi.upsertSubscription({ category, channelId: ch.id, enabled }),
        ),
      );
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      setBusyCat(null);
    }
  };

  const noChannels = channels.length === 0;

  return (
    <SettingsSection
      icon={Bell}
      title={t.settings.notifications.subscriptions.title}
      description={t.settings.notifications.subscriptions.description}
    >
      {/* Full-bleed and flush under the section header, so its rule lines up with
          the header's and the strip reads as a band rather than a floating row.
          `px-1` is the strip's gutter: each tab carries its own `px-4`, so 1+4
          puts the first label — and, since the underline is inset by that same
          `px-4`, the underline too — on the card's 20px content edge, level with
          the header icon, the EVENT column and every row beneath. */}
      <Tabs tabs={tabs} value={tab} onChange={setTab} className="-mx-5 -mt-5 mb-1 px-1" />
      <div className="overflow-x-auto -mx-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-start text-xs uppercase tracking-wide text-muted-foreground">
              {/* EVENT takes all the free width (`w-full`); `pe-8` keeps the
                  description text off the controls so it reads full-bleed.
                  `text-start` is not redundant with the row's: a `th` carries its
                  own UA `text-align: center`, which beats the inherited value, so
                  without it this one header floats centred over its column while
                  every event name under it is flush left. */}
              <th className="w-full px-5 py-2.5 pe-8 font-medium text-start">
                {t.settings.notifications.subscriptions.eventHeader}
              </th>
              <th className="px-4 py-2.5 font-medium text-start min-w-[160px]">
                {t.settings.notifications.channels.title}
              </th>
              <th className="px-5 py-2.5 font-medium text-center min-w-[112px]">
                {t.settings.notifications.orgDefaults.title}
              </th>
              <th className="px-5 py-2.5 pe-6 font-medium text-center min-w-[80px]">
                {t.settings.notifications.subscriptions.notifyMe}
              </th>
            </tr>
          </thead>
          {/* One tbody per section, so the group heading is a rowgroup header rather
              than a row pretending to be one. */}
          {sections.map((section) => (
            <tbody key={section.id}>
              {section.label && (
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={4}
                    className="border-t border-border/30 bg-muted/20 px-5 py-2 text-start text-xs font-semibold text-foreground/70"
                  >
                    {section.label}
                  </th>
                </tr>
              )}
              {section.cats.map((cat) => {
                const def = defIndex.get(cat.id);
                const enabled = def?.defaultEnabled ?? cat.defaultEnabled;
                const kinds = (def?.defaultChannelKinds?.length
                  ? def.defaultChannelKinds
                  : ["email"]) as ChannelKind[];
                const isBusy = busyCat === cat.id;
                // Checked when the user explicitly opted in, OR when they've made
                // no explicit choice and the category is default-enabled (the
                // dispatcher delivers to them in that case too).
                const notifyMe = enabledCats.has(cat.id) || (!rowCats.has(cat.id) && enabled);
                return (
                  <tr
                    key={cat.id}
                    className={`border-t border-border/30 transition-opacity ${isBusy ? "opacity-50" : ""}`}
                  >
                    <td className="px-5 py-3.5 pe-8 align-top">
                      <p className="font-medium text-foreground">{cat.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                        {cat.description}
                      </p>
                    </td>
                    {/* Org default (admin-only): which channel kinds + on/off for new members. */}
                    <td className="px-4 py-3.5 align-top">
                      <ChannelMultiSelect
                        value={kinds}
                        disabled={isBusy || !isAdmin}
                        onChange={(next) => setDefault(cat.id, enabled, next)}
                      />
                    </td>
                    <td className="px-5 py-3.5 align-middle text-center">
                      <Toggle
                        checked={enabled}
                        disabled={isBusy || !isAdmin}
                        onChange={(v: boolean) => setDefault(cat.id, v, kinds)}
                        aria-label={interpolate(t.settings.notifications.orgDefaults.notifyAria, {
                          category: cat.label,
                        })}
                      />
                    </td>
                    {/* Per-user opt-in — anyone can set their own, across their channels. */}
                    <td className="px-5 pe-6 py-3.5 align-middle text-center">
                      <input
                        type="checkbox"
                        disabled={isBusy || noChannels}
                        checked={notifyMe}
                        onChange={(e) => setNotifyMe(cat.id, e.target.checked)}
                        className="size-4 rounded border-border/50 cursor-pointer accent-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label={interpolate(t.settings.notifications.orgDefaults.notifyAria, {
                          category: cat.label,
                        })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
        {noChannels && (
          <p className="px-5 pt-3 text-sm text-muted-foreground">
            {t.settings.notifications.subscriptions.empty}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

// CHANNEL_LABELS exported in case other modules need it.
export { CHANNEL_LABELS };
