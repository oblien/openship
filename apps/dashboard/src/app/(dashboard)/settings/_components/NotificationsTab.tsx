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
 *   2. Subscriptions — a category × channel matrix. Each row is a
 *      stable category; each column is one of the user's channels.
 *      Cells are checkboxes that upsert/disable subscriptions.
 *
 *   3. Org defaults — admin-only section to set per-category
 *      defaults that apply when a NEW member joins this org.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Mail,
  Webhook,
  MessageSquare,
  MessageCircle,
  MessagesSquare,
  Smartphone,
  Plus,
  Trash2,
  Loader2,
  Send,
  AlertTriangle,
} from "lucide-react";
import { systemApi } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import {
  notificationsApi,
  type NotificationCategory,
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
};

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  email: "Email",
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  msteams: "Microsoft Teams",
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
const DEFAULT_KIND_CHOICES: ChannelKind[] = ["email", "webhook", "slack", "discord", "msteams"];

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
    >
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

      <div className="mt-4">
        {showForm ? (
          <NewChannelForm
            onCancel={() => setShowForm(false)}
            onSaved={async () => {
              setShowForm(false);
              await onChange();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/50 text-sm hover:bg-foreground/[0.04] transition"
          >
            <Plus className="size-4" strokeWidth={1.7} />
            {t.settings.notifications.channels.addChannel}
          </button>
        )}
      </div>
    </SettingsSection>
  );
}

function describeChannel(
  ch: NotificationChannel,
  labels: { slackWebhook: string; discordWebhook: string; msteamsWebhook: string; telegramChat: string; inApp: string },
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
    case "telegram":
      return labels.telegramChat;
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
      config = { token: botToken.trim(), chatId: chatId.trim() };

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
      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ChannelKind)}
          className="bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        >
          <option value="email">{t.settings.notifications.kinds.email}</option>
          <option value="webhook">{t.settings.notifications.kinds.webhook}</option>
          <option value="slack">{t.settings.notifications.kinds.slack}</option>
          <option value="discord">{t.settings.notifications.kinds.discord}</option>
          <option value="msteams">{t.settings.notifications.kinds.msteams}</option>
          <option value="telegram">{t.settings.notifications.kinds.telegram}</option>
          <option value="in_app">{t.settings.notifications.kinds.in_app}</option>
        </select>
        <input
          type="text"
          placeholder={t.settings.notifications.form.labelPlaceholder}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      </div>

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
      {kind === "telegram" && (
        <>
          <input
            type="password"
            placeholder={t.settings.notifications.form.telegramTokenPlaceholder}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Get a token from{" "}
            <a href="https://t.me/botfather" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground transition-colors">
              @BotFather
            </a>
          </p>
          <input
            type="text"
            placeholder={t.settings.notifications.form.telegramChatPlaceholder}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Send a message to your bot, then visit{" "}
            <code className="text-[11px] bg-foreground/[0.06] px-1 rounded">https://api.telegram.org/bot&lt;token&gt;/getUpdates</code>
            {" "}to find your chat ID.
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

/* ─── Event notifications card (org defaults + per-user opt-in, one list) ─── */

function EventNotificationsCard({
  categories,
  channels,
  subscriptions,
  defaults,
  isAdmin,
  onChange,
}: {
  categories: NotificationCategory[];
  channels: NotificationChannel[];
  subscriptions: NotificationSubscription[];
  defaults: NotificationDefault[];
  isAdmin: boolean;
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [busyCat, setBusyCat] = useState<string | null>(null);

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
      <div className="space-y-2">
        {categories.map((cat) => {
          const def = defIndex.get(cat.id);
          const enabled = def?.defaultEnabled ?? cat.defaultEnabled;
          const kind = (def?.defaultChannelKind ?? "email") as ChannelKind;
          const isBusy = busyCat === cat.id;
          return (
            <div
              key={cat.id}
              className={`flex items-center gap-4 py-2 border-b border-border/30 last:border-0 transition-opacity ${isBusy ? "opacity-50" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{cat.label}</p>
                <p className="text-xs text-muted-foreground">{cat.description}</p>
              </div>
              <select
                value={kind}
                disabled={isBusy}
                onChange={(e) => set(cat.id, enabled, e.target.value as ChannelKind)}
                className="bg-background border border-border/50 rounded-lg px-2 py-1.5 text-sm"
              >
                <option value="email">{t.settings.notifications.kinds.email}</option>
                <option value="webhook">{t.settings.notifications.kinds.webhook}</option>
                <option value="slack">{t.settings.notifications.kinds.slack}</option>
                <option value="discord">{t.settings.notifications.kinds.discord}</option>
                <option value="msteams">{t.settings.notifications.kinds.msteams}</option>
                <option value="telegram">{t.settings.notifications.kinds.telegram}</option>
                <option value="in_app">{t.settings.notifications.kinds.in_app}</option>
              </select>
              <Toggle
                checked={enabled}
                disabled={isBusy}
                onChange={(v: boolean) => set(cat.id, v, kind)}
                aria-label={interpolate(t.settings.notifications.orgDefaults.notifyAria, {
                  category: cat.label,
                })}
              />
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

// CHANNEL_LABELS exported in case other modules need it.
export { CHANNEL_LABELS };
