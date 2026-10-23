"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";

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
 *      defaults used when a member has not made an explicit category choice.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { getApiBaseUrl } from "@/lib/api/client";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { systemApi } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { NotificationDeliveryHistory } from "./NotificationDeliveryHistory";
import { NotificationChannelForm as ChannelForm } from "./NotificationChannelForm";
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
import { authClient, useSession } from "@/lib/auth-client";
import { useAuth } from "@/context/AuthContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ChannelLogo, CHANNEL_LABELS } from "@/components/ui/ChannelLogo";

// Channel marks + labels come from the shared component: the mail server's rule modal
// lists the same channels, and two copies is how one list shows brand logos while the
// other shows a raw kind in parentheses.
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
  const { t, locale } = useI18n();
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
      <Button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        variant="secondary"
        aria-expanded={open}
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
              <span className="grid size-5 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground ring-1 ring-background">
                +{value.length - 2}
              </span>
            )}
          </span>
          <span className="whitespace-nowrap text-muted-foreground">
            {interpolate(t.settings.notifications.orgDefaults.nChannels, {
              n: String(value.length),
            })}
          </span>
        </span>
        <UiIcon name="chevron-down" className="size-4 shrink-0 text-muted-foreground" />
      </Button>
      {open && (
        // Frosted-glass surface (`bg-popover/70` color-mix + `backdrop-blur-xl`).
        // CRITICAL: the blur container is NEVER given an opacity animation — an
        // element with opacity < 1 stops rendering its own backdrop-filter, so a
        // `fade-in` here would flash the blur off on open. The container only
        // TRANSLATES in (blur-safe); the entrance FADE lives on the inner items
        // wrapper below (child opacity doesn't touch the parent's backdrop-filter).
        <div
          role="menu"
          className="absolute top-full end-0 z-50 mt-1 w-52 overflow-hidden rounded-xl border border-border/60 bg-popover/70 p-1 shadow-xl shadow-black/[0.08] backdrop-blur-xl animate-in slide-in-from-top-1 duration-150"
        >
          <div className="animate-in fade-in duration-200">
            {DEFAULT_KIND_CHOICES.map((k) => {
              const on = value.includes(k);
              return (
                <Button
                  key={k}
                  type="button"
                  onClick={() => toggle(k)}
                  variant="ghost"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className="w-full justify-start"
                >
                  <span
                    className={`grid size-4 shrink-0 place-items-center rounded border transition-colors ${
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                    }`}
                  >
                    {on && <UiIcon name="check" className="size-3" />}
                  </span>
                  <ChannelLogo kind={k} className="size-4" />
                  <span className="flex-1 text-start">{t.settings.notifications.kinds[k]}</span>
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export interface NotificationSettingsProps {
  mode?: "settings" | "monitoring";
  section?: "all" | "channels" | "preferences";
}

/** Scope ownership remounts private results and drafts before a new account renders. */
export function NotificationSettings(props: NotificationSettingsProps) {
  const { user } = useAuth();
  const { data: session } = useSession();
  const resource = useCloudResourceKey();
  const scope = JSON.stringify([
    getApiBaseUrl(),
    resource,
    user?.id,
    session?.session?.activeOrganizationId,
  ]);
  if (!user) return null;
  return <ScopedNotificationSettings key={scope} {...props} />;
}

function NotificationSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-2xl bg-card p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function useActiveView() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}

function ScopedNotificationSettings({
  section = "all",
  ...props
}: NotificationSettingsProps) {
  const { t } = useI18n();
  const [view, setView] = useState<"preferences" | "history">("preferences");
  const tabsId = useId();
  if (section === "channels") return <NotificationPreferences {...props} section={section} />;
  return (
    <div className="space-y-5">
      <Tabs
        idPrefix={tabsId}
        ariaLabel={t.settings.notifications.overview.title}
        value={view}
        onChange={setView}
        tabs={[
          { key: "preferences", label: t.settings.notifications.overview.configuration },
          { key: "history", label: t.settings.notifications.deliveryHistory.title },
        ]}
      />
      <div role="tabpanel" id={`${tabsId}-panel-preferences`} aria-labelledby={`${tabsId}-tab-preferences`} hidden={view !== "preferences"}>
        <NotificationPreferences {...props} section={section} />
      </div>
      {view === "history" && (
        <div role="tabpanel" id={`${tabsId}-panel-history`} aria-labelledby={`${tabsId}-tab-history`}>
          <NotificationDeliveryHistory />
        </div>
      )}
    </div>
  );
}

function NotificationPreferences({
  mode = "settings",
  section = "all",
}: NotificationSettingsProps) {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const active = useActiveView();
  const generation = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
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
      if (!active.current) return;
      const request = ++generation.current;
      const silent = opts?.silent ?? false;
      if (!silent) setLoading(true);
      try {
        const [cats, ch, subs, defs] = await Promise.all([
          notificationsApi.listCategories(),
          notificationsApi.listChannels(),
          notificationsApi.listSubscriptions(),
          notificationsApi.listDefaults(),
        ]);
        if (!active.current || request !== generation.current) return;
        setError(null);
        setLoaded(true);
        setCategories(cats.categories);
        setCategoryGroups(cats.groups);
        setChannels(ch.channels);
        setSubscriptions(subs.subscriptions);
        setDefaults(defs.defaults);
      } catch (err) {
        if (active.current && request === generation.current) setError(getApiErrorMessage(err));
      } finally {
        if (active.current && request === generation.current && !silent) setLoading(false);
      }
    },
    [active],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Resolve caller's role in active org so we can gate the defaults UI.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
        if (cancelled) return;
        const me = result.data?.members?.find((m) => m.userId === user?.id);
        setRole(me?.role ?? null);
      } catch (diagnosticFailure) {
        observeCaughtError(
          diagnosticFailure,
          "dashboard/app/(dashboard)/settings/_components/NotificationsTab",
        );
        if (!cancelled) setRole(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <UiIcon name="spinner" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !loaded)
    return (
      <div role="alert" className="rounded-2xl bg-card p-5 space-y-3">
        <p className="text-sm text-danger">{error}</p>
        <Button variant="secondary" onClick={() => refresh()}>
          {t.settings.notifications.overview.retry}
        </Button>
      </div>
    );

  return (
    <div className="@container space-y-6" data-mode={mode}>
      {error && (
        <div role="alert" className="rounded-2xl bg-card p-5 text-sm text-danger">
          {error}
          <Button variant="secondary" onClick={() => refresh()}>
            {t.settings.notifications.overview.retry}
          </Button>
        </div>
      )}
      {section !== "preferences" && (
        <div className="rounded-2xl bg-card p-5">
          <h2 className="text-base font-medium text-foreground">
            {t.settings.notifications.overview.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.settings.notifications.overview.description}
          </p>
          <p className="mt-3 text-sm text-foreground">
            {interpolate(t.settings.notifications.overview.ready, {
              count: String(channels.filter((ch) => ch.enabled && ch.verified).length),
              total: String(channels.length),
            })}
          </p>
        </div>
      )}
      {section !== "preferences" && (
        <ChannelsCard channels={channels} onChange={() => refresh({ silent: true })} />
      )}
      {section !== "channels" && (
        <EventNotificationsCard
          categories={categories}
          groups={categoryGroups}
          channels={channels}
          subscriptions={subscriptions}
          defaults={defaults}
          isAdmin={isAdmin}
          disabled={error !== null}
          onChange={() => refresh({ silent: true })}
        />
      )}
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
  const { t, locale } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | undefined>();
  const [testing, setTesting] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const active = useActiveView();
  const toggleEnabled = async (channel: NotificationChannel, enabled: boolean) => {
    setUpdating(channel.id);
    try {
      await notificationsApi.updateChannel(channel.id, { enabled });
      if (active.current) await onChange();
    } catch (error) {
      if (active.current)
        showToast(getApiErrorMessage(error), "error", t.settings.common.toast.notifications);
    } finally {
      if (active.current) setUpdating(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t.settings.notifications.channels.confirmDelete)) return;
    try {
      await notificationsApi.deleteChannel(id);
      if (!active.current) return;
      showToast(
        t.settings.notifications.channels.channelRemoved,
        "success",
        t.settings.common.toast.notifications,
      );
      if (active.current) await onChange();
    } catch (err) {
      if (active.current)
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
      if (!active.current) return;
      showToast(
        t.settings.notifications.channels.testSent,
        "success",
        t.settings.common.toast.notifications,
      );
      if (active.current) await onChange();
    } catch (err) {
      if (active.current)
        showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      if (active.current) setTesting(null);
    }
  };

  return (
    <NotificationSection
      title={t.settings.notifications.channels.title}
      description={t.settings.notifications.channels.description}
      /* In the header, not under the list: the list grows, so a button below it
         walks further from the heading with every channel added, and the form it
         opens is what should hold the reader's attention once it is open — hence
         no second trigger while the form is up (it carries its own Cancel). */
      action={
        showForm ? null : (
          <Button
            type="button"
            onClick={() => {
              setEditing(undefined);
              setShowForm(true);
            }}
            variant="secondary"
          >
            <UiIcon name="plus" className="size-4" />
            {t.settings.notifications.channels.addChannel}
          </Button>
        )
      }
    >
      {showForm && (
        <div className="mb-4">
          <ChannelForm
            key={editing?.id ?? "new"}
            channel={editing}
            onCancel={() => setShowForm(false)}
            onSaved={async () => {
              setShowForm(false);
              if (active.current) await onChange();
            }}
          />
        </div>
      )}

      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.settings.notifications.channels.empty}</p>
      ) : (
        <ul className="grid gap-4 @3xl:grid-cols-2">
          {channels.map((ch) => (
            <li key={ch.id} className="flex flex-wrap items-start gap-3 rounded-xl bg-card p-4">
              <div className="size-9 rounded-lg bg-muted flex items-center justify-center">
                <ChannelLogo kind={ch.kind} className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{ch.label}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {describeChannel(ch, t.settings.notifications.describe)}
                </p>
              </div>
              <DropdownMenu
                triggerLabel={`${t.projects.card.more}: ${ch.label}`}
                className="shrink-0"
                actions={[
                  {
                    id: "edit",
                    label: t.settings.notifications.channels.edit,
                    icon: <UiIcon name="edit" className="size-4" />,
                    disabled: showForm,
                    onClick: () => {
                      setEditing(ch);
                      setShowForm(true);
                    },
                  },
                  {
                    id: "delete",
                    label: t.settings.notifications.channels.deleteChannel,
                    icon: <UiIcon name="trash" className="size-4" />,
                    variant: "danger",
                    onClick: () => void handleDelete(ch.id),
                  },
                ]}
              />
              <div className="flex w-full flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {ch.enabled
                    ? t.settings.notifications.channels.enabled
                    : t.settings.notifications.channels.disabled}
                </span>
                <Switch
                  checked={ch.enabled}
                  disabled={updating === ch.id}
                  ariaLabel={`${t.settings.notifications.channels.enabled}: ${ch.label}`}
                  onChange={(enabled) => toggleEnabled(ch, enabled)}
                />
                {ch.verified ? (
                  <span className="text-xs text-success">
                    {t.settings.notifications.channels.verified}
                  </span>
                ) : ch.kind !== "in_app" ? (
                  <span className="text-xs text-warning">
                    {t.settings.notifications.channels.unverified}
                  </span>
                ) : null}
                {/* In-app has nothing to prove; everything else can send a test to
                    verify reachability (and flip the Unverified badge). */}
                {ch.kind !== "in_app" && (
                  <Button
                    type="button"
                    onClick={() => handleTest(ch.id)}
                    disabled={testing === ch.id}
                    variant="secondary"
                    className="ms-auto"
                  >
                    {testing === ch.id ? (
                      <UiIcon name="spinner" className="size-3.5 animate-spin" />
                    ) : (
                      <UiIcon name="send" className="size-3.5" />
                    )}
                    {t.settings.notifications.channels.sendTest}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </NotificationSection>
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
      return cfg.messageThreadId
        ? `${cfg.chatId ?? ""} · #${cfg.messageThreadId}`
        : String(cfg.chatId ?? "");
    }
    case "in_app":
      return labels.inApp;
    default:
      return "";
  }
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
  disabled,
  onChange,
}: {
  categories: NotificationCategory[];
  groups: NotificationCategoryGroup[];
  channels: NotificationChannel[];
  subscriptions: NotificationSubscription[];
  defaults: NotificationDefault[];
  isAdmin: boolean;
  disabled: boolean;
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const { t, locale } = useI18n();
  const active = useActiveView();
  const [busyCat, setBusyCat] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(ALL_TAB);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearch("");
    searchTrigger.current?.focus();
  };
  const visibleCategories = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale);
    return categories
      .map((cat) => {
        const translated = (t.settings.notifications as any)?.categories?.[cat.id];
        return locale === "en" ? cat : {
          ...cat,
          label: translated?.label ?? cat.label,
          description: translated?.description ?? cat.description,
        };
      })
      .filter((cat) =>
        !query || `${cat.label} ${cat.description}`.toLocaleLowerCase(locale).includes(query),
      );
  }, [categories, search, t, locale]);

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
        label: locale !== "en" ? ((t.settings.notifications as any)?.groups?.[g.id] ?? g.label) : g.label,
        count: byGroup.get(g.id) ?? 0,
        hidden: !byGroup.has(g.id),
      })),
    ];
  }, [categories, groups, t, locale]);

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
      const cats = visibleCategories.filter((cat) => cat.group === tab);
      return cats.length ? [{ id: tab, label: null, cats }] : [];
    }
    const out = groups
      .map((g) => ({
        id: g.id,
        label: (locale !== "en" ? ((t.settings.notifications as any)?.groups?.[g.id] ?? g.label) : g.label) as string | null,
        cats: visibleCategories.filter((cat) => cat.group === g.id),
      }))
      .filter((s) => s.cats.length > 0);
    const known = new Set(groups.map((g) => g.id));
    const rest = visibleCategories.filter((cat) => !known.has(cat.group));
    if (rest.length > 0) out.push({ id: "__ungrouped__", label: null, cats: rest });
    return out;
  }, [visibleCategories, groups, tab, t, locale]);

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

  // Admin: the org default (channel kinds + on/off) used until a member makes an explicit category choice.
  const setDefault = async (category: string, enabled: boolean, kinds: ChannelKind[]) => {
    if (disabled) return;
    setBusyCat(category);
    try {
      await notificationsApi.upsertDefault({
        category,
        defaultEnabled: enabled,
        defaultChannelKinds: kinds,
      });
      if (active.current) await onChange();
    } catch (err) {
      if (active.current)
        showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      if (active.current) setBusyCat(null);
    }
  };

  // Per-user: one checkbox toggles the subscription across ALL the caller's
  // channels (the backend model is per-channel, so we fan the write out).
  const setNotifyMe = async (category: string, enabled: boolean) => {
    if (disabled) return;
    setBusyCat(category);
    try {
      await Promise.all(
        channels.map((ch) =>
          notificationsApi.upsertSubscription({ category, channelId: ch.id, enabled }),
        ),
      );
      if (active.current) await onChange();
    } catch (err) {
      if (active.current)
        showToast(getApiErrorMessage(err), "error", t.settings.common.toast.notifications);
    } finally {
      if (active.current) setBusyCat(null);
    }
  };

  const noChannels = channels.length === 0;

  return (
    <NotificationSection
      title={t.settings.notifications.overview.preferences}
      description={t.settings.notifications.orgDefaults.description}
      action={
        <Button
          ref={searchTrigger}
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={searchOpen
            ? t.settings.common.close
            : t.settings.notifications.subscriptions.search}
          aria-expanded={searchOpen}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
        >
          <UiIcon name={searchOpen ? "close" : "search"} className="size-4" />
        </Button>
      }
    >
      {searchOpen && (
        <Input
          autoFocus
          type="search"
          variant="filled"
          value={search}
          aria-label={t.settings.notifications.subscriptions.search}
          placeholder={t.settings.notifications.subscriptions.search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }
          }}
        />
      )}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="space-y-5">
        {search.trim() && sections.length === 0 && (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            {t.settings.notifications.subscriptions.noResults}
          </p>
        )}
        {sections.map((section) => (
          <section key={section.id} className="space-y-3">
            {section.label && (
              <h3 className="text-sm font-medium text-foreground">{section.label}</h3>
            )}
            {section.cats.map((cat) => {
              const catLabel = cat.label;
              const catDesc = cat.description;
              const def = defIndex.get(cat.id);
              const enabled = def?.defaultEnabled ?? cat.defaultEnabled;
              const kinds = (
                def?.defaultChannelKinds?.length ? def.defaultChannelKinds : ["email"]
              ) as ChannelKind[];
              const isBusy = busyCat === cat.id;
              const notifyMe = enabledCats.has(cat.id) || (!rowCats.has(cat.id) && enabled);
              return (
                <div key={cat.id} className="space-y-4 rounded-xl bg-card p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{catLabel}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{catDesc}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-foreground">
                        {t.settings.notifications.subscriptions.notifyMe}
                      </span>
                      <Switch
                        checked={notifyMe}
                        disabled={disabled || isBusy || noChannels}
                        onChange={(value) => setNotifyMe(cat.id, value)}
                        ariaLabel={`${t.settings.notifications.subscriptions.notifyMe}: ${catLabel}`}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">
                        {t.settings.notifications.orgDefaults.title}
                      </span>
                      <Switch
                        checked={enabled}
                        disabled={disabled || isBusy || !isAdmin}
                        onChange={(value) => setDefault(cat.id, value, kinds)}
                        ariaLabel={interpolate(t.settings.notifications.orgDefaults.notifyAria, {
                          category: catLabel,
                        })}
                      />
                    </div>
                    <div className="ms-auto">
                      <ChannelMultiSelect
                        value={kinds}
                        disabled={disabled || isBusy || !isAdmin}
                        onChange={(next) => setDefault(cat.id, enabled, next)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        {noChannels && (
          <p className="text-sm text-muted-foreground">
            {t.settings.notifications.subscriptions.empty}
          </p>
        )}
      </div>
    </NotificationSection>
  );
}

// CHANNEL_LABELS exported in case other modules need it.
export { CHANNEL_LABELS };
