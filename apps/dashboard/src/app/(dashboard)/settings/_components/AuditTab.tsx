"use client";

/**
 * Audit log — a readable history of who did what in this organization.
 *
 * The feed renders sentences, not table rows: the shared taxonomy in
 * `@repo/core` turns `deployment.succeeded` into a past-tense verb and the API
 * resolves resource ids into names, so a row reads "Sarah deployed api-gateway"
 * rather than "deployment.succeeded · prj_8fk2abc". Raw event types, ids and the
 * before/after payload still exist — demoted into the details modal's
 * "Technical details" section, where a forensic reader can find them.
 *
 * Filtering is server-side (GET /api/audit) across category, actor, source,
 * date range and free text; `/api/audit/facets` supplies the tab counts, the
 * actor list and the recording switch in one request. Source is the reason the
 * `source` column exists at all: an action taken by an AI assistant over MCP is
 * otherwise indistinguishable on the wire from a scripted API call.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  Bell,
  Bot,
  Check,
  ChevronDown,
  Copy,
  CreditCard,
  Globe,
  Loader2,
  Package,
  Rocket,
  Search,
  Server,
  Shield,
  Terminal,
  User as UserIcon,
  Users,
  Webhook,
  Wrench,
} from "lucide-react";
import {
  auditApi,
  getApiErrorMessage,
  type AuditEventRow,
  type AuditFacets,
  type AuditSource,
} from "@/lib/api";
import {
  AUDIT_CATEGORIES,
  auditResourceLabel,
  describeAuditEvent,
  type AuditCategoryId,
  type AuditTone,
} from "@repo/core";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { Switch } from "@/components/ui/Switch";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { PillSwitcher, type PillOption } from "@/components/ui/PillSwitcher";

const PER_PAGE = 50;

/** Must match RETENTION_CHOICES in apps/api/src/modules/audit/audit.routes.ts. */
const RETENTION_CHOICES = [7, 30, 90, 180, 365];

type CategoryKey = "all" | AuditCategoryId;
type SourceKey = "all" | AuditSource;
type PeriodKey = "all" | "today" | "7d" | "30d" | "90d";

const CATEGORY_ICONS: Record<AuditCategoryId, React.ComponentType<{ className?: string }>> = {
  deployments: Rocket,
  apps: Package,
  domains: Globe,
  servers: Server,
  members: Users,
  security: Shield,
  billing: CreditCard,
  system: Wrench,
};

const SOURCE_ICONS: Record<AuditSource, typeof Bot> = {
  dashboard: Activity,
  mcp: Bot,
  cli: Terminal,
  api: Webhook,
  webhook: Bell,
  system: Wrench,
};

/** Theme status tokens — never a literal colour, so a theme swap stays coherent. */
const TONE_DOT: Record<AuditTone, string> = {
  neutral: "bg-neutral-solid",
  info: "bg-info-solid",
  success: "bg-success-solid",
  warning: "bg-warning-solid",
  danger: "bg-danger-solid",
};

/**
 * `from` for a period preset, anchored to local midnight so "Last 7 days" means
 * seven calendar days as the reader sees them, not a rolling 168 hours.
 */
function periodStart(period: PeriodKey): string | undefined {
  if (period === "all") return undefined;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const back = period === "today" ? 0 : period === "7d" ? 6 : period === "30d" ? 29 : 89;
  start.setDate(start.getDate() - back);
  return start.toISOString();
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Local `YYYY-MM-DD` — the day-group key. `toISOString` would group by UTC. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function actorDisplay(e: AuditEventRow, labels: { system: string; actorPrefix: string }): string {
  if (e.actor) {
    if (e.actor.name && e.actor.name.trim()) return e.actor.name;
    if (e.actor.email) return e.actor.email;
    return e.actor.id.slice(0, 8);
  }
  if (e.actorUserId) return interpolate(labels.actorPrefix, { id: e.actorUserId.slice(0, 8) });
  return labels.system;
}

/**
 * What the row calls the thing that was acted on.
 *
 * `resourceName` covers everything the API can name from a table with a name
 * column. Member and invitation rows can't be named that way — they store a
 * membership id and keep the human identity in the payload — so those fall back
 * to the email/name recorded at the time, and only then to a generic noun.
 */
function resourceDisplay(e: AuditEventRow): string {
  if (e.resourceName) return e.resourceName;
  const payload = (e.after ?? e.before) as Record<string, unknown> | null | undefined;
  if (payload && typeof payload === "object") {
    for (const field of ["email", "hostname", "name", "slug"]) {
      const value = payload[field];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return auditResourceLabel(e.resourceType);
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Details modal                                                       */
/* ──────────────────────────────────────────────────────────────────── */

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
      aria-label={copied ? t.settings.common.copied : t.settings.common.copy}
      title={copied ? t.settings.common.copied : t.settings.common.copy}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

function JsonBlock({ value, label }: { value: unknown; label: string }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? "null";
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <CopyButton value={text} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-lg border border-border/50 bg-muted/30 p-3 text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words font-mono">
        {text}
      </pre>
    </div>
  );
}

function DetailRow({
  label,
  value,
  copyable,
  mono,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={`flex-1 text-sm text-foreground break-all ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
      {copyable && value !== "—" && <CopyButton value={value} />}
    </div>
  );
}

function AuditDetailsBody({
  event,
  onClose,
  sourceLabel,
}: {
  event: AuditEventRow;
  onClose: () => void;
  sourceLabel: (source: AuditSource | null) => string;
}) {
  const { t } = useI18n();
  const [showTechnical, setShowTechnical] = useState(false);
  const info = describeAuditEvent(event.eventType);
  const tone = info.tone ?? "neutral";
  const hasBefore = event.before !== null && event.before !== undefined;
  const hasAfter = event.after !== null && event.after !== undefined;
  const actor = actorDisplay(event, {
    system: t.settings.audit.system,
    actorPrefix: t.settings.audit.actorPrefix,
  });
  const resource = resourceDisplay(event);

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
            <h2 className="text-lg font-semibold text-foreground">{info.label}</h2>
          </div>
          <p className="mt-1.5 text-sm text-foreground/80">
            <span className="font-medium">{actor}</span> {info.action}
            {resource && <span className="font-medium"> {resource}</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground" title={absoluteTime(event.createdAt)}>
            {relativeTime(event.createdAt)} · {absoluteTime(event.createdAt)}
          </p>
          {info.description && (
            <p className="mt-2 text-sm text-muted-foreground">{info.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label={t.settings.common.close}
        >
          {t.settings.common.close}
        </button>
      </div>

      <section className="rounded-xl bg-card p-4">
        <DetailRow label={t.settings.audit.details.who} value={actor} />
        <DetailRow label={t.settings.audit.email} value={event.actor?.email || "—"} />
        <DetailRow
          label={t.settings.audit.details.cameFrom}
          value={sourceLabel(event.source)}
        />
        <DetailRow label={t.settings.audit.details.when} value={absoluteTime(event.createdAt)} />
        <DetailRow label={t.settings.audit.ip} value={event.ipAddress || "—"} copyable={!!event.ipAddress} mono />
        {(event.resourceType || event.resourceId) && (
          <DetailRow label={t.settings.audit.resource} value={resource || "—"} />
        )}
      </section>

      <section className="rounded-xl bg-card">
        <button
          type="button"
          onClick={() => setShowTechnical((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start"
          aria-expanded={showTechnical}
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t.settings.audit.details.technical}
          </span>
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${showTechnical ? "rotate-180" : ""}`}
          />
        </button>
        {showTechnical && (
          <div className="border-t border-border/40 px-4 pb-4 pt-2">
            <DetailRow label={t.settings.audit.details.eventType} value={event.eventType} copyable mono />
            <DetailRow label={t.settings.audit.type} value={event.resourceType || "—"} mono />
            <DetailRow
              label={t.settings.audit.id}
              value={event.resourceId || "—"}
              copyable={!!event.resourceId}
              mono
            />
            <DetailRow
              label={t.settings.audit.userId}
              value={event.actorUserId || "—"}
              copyable={!!event.actorUserId}
              mono
            />
            <DetailRow
              label={t.settings.audit.userAgent}
              value={event.userAgent ? event.userAgent.slice(0, 200) : "—"}
            />
            {(hasBefore || hasAfter) && (
              <div className="mt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t.settings.audit.changes}
                </h3>
                {hasBefore && hasAfter ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <JsonBlock value={event.before} label={t.settings.audit.before} />
                    <JsonBlock value={event.after} label={t.settings.audit.after} />
                  </div>
                ) : hasAfter ? (
                  <JsonBlock value={event.after} label={t.settings.audit.after} />
                ) : (
                  <JsonBlock value={event.before} label={t.settings.audit.removed} />
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Recording switch                                                    */
/* ──────────────────────────────────────────────────────────────────── */

function RecordingCard({
  enabled,
  retentionDays,
  canManage,
  saving,
  onToggle,
  onRetentionChange,
}: {
  enabled: boolean;
  retentionDays: number;
  canManage: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
  onRetentionChange: (days: number) => void;
}) {
  const { t } = useI18n();
  const a = t.settings.audit.recording;

  return (
    <div className="rounded-2xl bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{a.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>
          {!canManage && <p className="mt-1 text-xs text-muted-foreground/70">{a.adminOnly}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Switch
            checked={enabled}
            onChange={onToggle}
            disabled={!canManage || saving}
            ariaLabel={a.title}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
        <span className="text-xs text-muted-foreground">{a.retention}</span>
        <CustomSelect
          value={String(retentionDays)}
          options={RETENTION_CHOICES.map((days) => ({
            value: String(days),
            label: interpolate(a.retentionOption, { days: String(days) }),
          }))}
          onChange={(value) => onRetentionChange(Number(value))}
          className={`w-36 ${!canManage || saving ? "pointer-events-none opacity-50" : ""}`}
        />
        <span className="text-xs text-muted-foreground/70">{a.retentionHint}</span>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Feed                                                                */
/* ──────────────────────────────────────────────────────────────────── */

function FeedSkeleton() {
  return (
    <div className="rounded-2xl bg-card p-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-3.5">
          <div className="size-8 shrink-0 rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 rounded bg-muted" style={{ width: `${45 + ((i * 13) % 35)}%` }} />
            <div className="h-2.5 w-24 rounded bg-muted" />
          </div>
          <div className="h-2.5 w-12 shrink-0 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Page                                                                */
/* ──────────────────────────────────────────────────────────────────── */

export function AuditTab() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const router = useRouter();
  const searchParams = useSearchParams();

  const categoryParam = searchParams.get("category");
  const category: CategoryKey = useMemo(() => {
    const hit = AUDIT_CATEGORIES.find((c) => c.id === categoryParam);
    return hit ? hit.id : "all";
  }, [categoryParam]);

  const [source, setSource] = useState<SourceKey>("all");
  const [actorUserId, setActorUserId] = useState("");
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Typing shouldn't fire a query per keystroke — `q` resolves names across
  // three tables server-side.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  const query = useMemo(
    () => ({
      category: category === "all" ? undefined : category,
      source: source === "all" ? undefined : source,
      actorUserId: actorUserId || undefined,
      from: periodStart(period),
      q: debouncedSearch || undefined,
    }),
    [category, source, actorUserId, period, debouncedSearch],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void auditApi
      .list({ ...query, page, perPage: PER_PAGE })
      .then((res) => {
        if (cancelled) return;
        setEvents(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load audit events", err);
        setEvents([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, page]);

  // Facets are counted with every filter except the one they describe, so they
  // reload with the query but not with the page.
  useEffect(() => {
    let cancelled = false;
    void auditApi
      .facets(query)
      .then((res) => {
        if (!cancelled) setFacets(res);
      })
      .catch((err) => {
        if (!cancelled) console.error("Failed to load audit facets", err);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const settings = facets?.settings ?? { enabled: true, retentionDays: 90 };
  const canManage = facets?.canManage ?? false;

  const sourceLabel = useCallback(
    (value: AuditSource | null): string => {
      if (!value) return t.settings.audit.sources.unknown;
      return t.settings.audit.sources[value] ?? value;
    },
    [t],
  );

  const saveSettings = useCallback(
    async (patch: { enabled?: boolean; retentionDays?: number }) => {
      setSavingSettings(true);
      // Optimistic: the switch is the control the user is looking at, and the
      // facets refetch below is the reconciliation.
      setFacets((prev) => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
      try {
        const next = await auditApi.updateSettings(patch);
        setFacets((prev) =>
          prev
            ? { ...prev, settings: { enabled: next.enabled, retentionDays: next.retentionDays } }
            : prev,
        );
        // Turning recording off writes an `audit.disabled` row; turning it on
        // writes `audit.enabled`. Reload so that row is visible immediately.
        const res = await auditApi.list({ ...query, page: 1, perPage: PER_PAGE });
        setEvents(res.data);
        setTotal(res.total);
        setPage(1);
      } catch (err) {
        showToast(
          getApiErrorMessage(err) || t.settings.audit.recording.saveFailed,
          "error",
          t.settings.common.toast.settings,
        );
        const fresh = await auditApi.facets(query).catch(() => null);
        if (fresh) setFacets(fresh);
      } finally {
        setSavingSettings(false);
      }
    },
    [query, showToast, t],
  );

  // Every filter change invalidates the offset — page 3 of the old result set
  // has nothing to do with the new one, so each setter resets it rather than an
  // effect on `query` (which would fetch the stale page first, then page 1).
  const setCategory = useCallback(
    (next: CategoryKey) => {
      const url = next === "all" ? "/settings?tab=audit" : `/settings?tab=audit&category=${next}`;
      router.replace(url, { scroll: false });
      setPage(1);
    },
    [router],
  );

  const pickSource = useCallback((next: SourceKey) => {
    setSource(next);
    setPage(1);
  }, []);

  const pickActor = useCallback((next: string) => {
    setActorUserId(next);
    setPage(1);
  }, []);

  const pickPeriod = useCallback((next: PeriodKey) => {
    setPeriod(next);
    setPage(1);
  }, []);

  const typeSearch = useCallback((next: string) => {
    setSearch(next);
    setPage(1);
  }, []);

  const tabs: TabDef<CategoryKey>[] = useMemo(() => {
    const counts = new Map(facets?.categories.map((c) => [c.id, c.count]) ?? []);
    return [
      {
        key: "all" as CategoryKey,
        label: t.settings.audit.tabs.all,
        count: facets?.total,
        href: "/settings?tab=audit",
      },
      ...AUDIT_CATEGORIES.map((cat) => ({
        key: cat.id as CategoryKey,
        label: cat.label,
        icon: CATEGORY_ICONS[cat.id],
        count: counts.get(cat.id),
        href: `/settings?tab=audit&category=${cat.id}`,
      })),
    ];
  }, [facets, t]);

  const sourceOptions: PillOption<SourceKey>[] = useMemo(() => {
    const seen = new Set(
      (facets?.sources ?? []).map((s) => s.source).filter((s): s is AuditSource => !!s),
    );
    // Always offer the source currently selected, even at zero, or the filter
    // becomes a one-way door.
    const order: AuditSource[] = ["dashboard", "mcp", "cli", "api", "webhook", "system"];
    return [
      { value: "all" as SourceKey, label: t.settings.audit.sources.all },
      ...order
        .filter((s) => seen.has(s) || source === s)
        .map((s) => ({
          value: s as SourceKey,
          label: t.settings.audit.sources[s],
          icon: SOURCE_ICONS[s],
        })),
    ];
  }, [facets, source, t]);

  const actorOptions = useMemo(
    () => [
      { value: "", label: t.settings.audit.filters.anyone },
      ...(facets?.actors ?? []).map((a) => ({
        value: a.id,
        label: a.name?.trim() || a.email || a.id.slice(0, 8),
        description: a.name?.trim() && a.email ? a.email : undefined,
      })),
    ],
    [facets, t],
  );

  const periodOptions = useMemo(
    () => [
      { value: "all" as PeriodKey, label: t.settings.audit.filters.allTime },
      { value: "today" as PeriodKey, label: t.settings.audit.filters.today },
      { value: "7d" as PeriodKey, label: t.settings.audit.filters.last7 },
      { value: "30d" as PeriodKey, label: t.settings.audit.filters.last30 },
      { value: "90d" as PeriodKey, label: t.settings.audit.filters.last90 },
    ],
    [t],
  );

  const openDetails = useCallback(
    (event: AuditEventRow) => {
      // Capture the modal id so the body's close button dismisses this exact
      // instance even if another modal is pushed on top.
      let modalId = "";
      modalId = showModal({
        maxWidth: "720px",
        showCloseButton: true,
        customContent: (
          <AuditDetailsBody
            event={event}
            onClose={() => hideModal(modalId)}
            sourceLabel={sourceLabel}
          />
        ),
      });
    },
    [showModal, hideModal, sourceLabel],
  );

  /** Rows grouped into day buckets, preserving the server's newest-first order. */
  const days = useMemo(() => {
    const groups: { key: string; label: string; rows: AuditEventRow[] }[] = [];
    const todayKey = dayKey(new Date().toISOString());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = dayKey(yesterday.toISOString());

    for (const row of events) {
      const key = dayKey(row.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.rows.push(row);
        continue;
      }
      const label =
        key === todayKey
          ? t.settings.audit.day.today
          : key === yesterdayKey
            ? t.settings.audit.day.yesterday
            : new Date(row.createdAt).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                year:
                  new Date(row.createdAt).getFullYear() === new Date().getFullYear()
                    ? undefined
                    : "numeric",
              });
      groups.push({ key, label, rows: [row] });
    }
    return groups;
  }, [events, t]);

  const filtersActive =
    category !== "all" || source !== "all" || !!actorUserId || period !== "all" || !!debouncedSearch;

  const clearFilters = useCallback(() => {
    setSource("all");
    setActorUserId("");
    setPeriod("all");
    setSearch("");
    setCategory("all");
  }, [setCategory]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
          {t.settings.audit.heading}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.settings.audit.subtitle}</p>
      </div>

      <RecordingCard
        enabled={settings.enabled}
        retentionDays={settings.retentionDays}
        canManage={canManage}
        saving={savingSettings}
        onToggle={(next) => void saveSettings({ enabled: next })}
        onRetentionChange={(days) => void saveSettings({ retentionDays: days })}
      />

      {!settings.enabled && (
        <div className="rounded-xl bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {t.settings.audit.recording.paused}
        </div>
      )}

      <Tabs tabs={tabs} value={category} onChange={setCategory} />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => typeSearch(e.target.value)}
              placeholder={t.settings.audit.searchPlaceholder}
              className="w-full rounded-xl border border-border/50 bg-muted/30 py-2 pe-3 ps-10 text-sm text-foreground transition-all placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <CustomSelect
            value={actorUserId}
            options={actorOptions}
            onChange={pickActor}
            placeholder={t.settings.audit.filters.anyone}
            className="w-52"
          />
          <CustomSelect
            value={period}
            options={periodOptions}
            onChange={pickPeriod}
            placeholder={t.settings.audit.filters.period}
            className="w-40"
          />
        </div>
        {sourceOptions.length > 1 && (
          <PillSwitcher options={sourceOptions} value={source} onChange={pickSource} size="sm" />
        )}
      </div>

      {loading ? (
        <FeedSkeleton />
      ) : events.length === 0 ? (
        <div className="rounded-2xl bg-card py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {filtersActive ? t.settings.audit.noMatch : t.settings.audit.noEvents}
          </p>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-3 text-xs font-medium text-primary hover:underline"
            >
              {t.settings.audit.clearFilters}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {days.map((day) => (
            <div key={day.key} className="overflow-hidden rounded-2xl bg-card">
              <div className="border-b border-border/40 px-5 py-2.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {day.label}
                </span>
              </div>
              <div className="divide-y divide-border/40">
                {day.rows.map((e) => {
                  const info = describeAuditEvent(e.eventType);
                  const tone = info.tone ?? "neutral";
                  const actor = actorDisplay(e, {
                    system: t.settings.audit.system,
                    actorPrefix: t.settings.audit.actorPrefix,
                  });
                  const resource = resourceDisplay(e);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => openDetails(e)}
                      className="flex w-full items-center gap-4 px-5 py-3.5 text-start transition-colors hover:bg-muted/30 focus:bg-muted/40 focus:outline-none"
                    >
                      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/60">
                        <UserIcon className="size-3.5 text-muted-foreground" />
                        <span
                          className={`absolute -bottom-0.5 -end-0.5 size-2.5 rounded-full ring-2 ring-card ${TONE_DOT[tone]}`}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">
                          <span className="font-medium">{actor}</span> {info.action}
                          {resource && <span className="font-medium"> {resource}</span>}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{clockTime(e.createdAt)}</span>
                          {e.source === "mcp" && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-info-bg px-1.5 py-0.5 text-[10px] font-medium text-info">
                              <Bot className="size-2.5" />
                              {t.settings.audit.sources.mcp}
                            </span>
                          )}
                          {e.source && e.source !== "mcp" && e.source !== "dashboard" && (
                            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px]">
                              {sourceLabel(e.source)}
                            </span>
                          )}
                        </p>
                      </div>
                      <time
                        className="shrink-0 text-xs text-muted-foreground"
                        title={absoluteTime(e.createdAt)}
                      >
                        {relativeTime(e.createdAt)}
                      </time>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {total > PER_PAGE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {interpolate(t.settings.audit.showing, {
              from: String((page - 1) * PER_PAGE + 1),
              to: String(Math.min(page * PER_PAGE, total)),
              total: String(total),
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="rounded-lg border border-border/50 px-3 py-1.5 transition-colors hover:bg-muted/40 disabled:opacity-50"
            >
              {t.settings.common.previous}
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * PER_PAGE >= total || loading}
              className="rounded-lg border border-border/50 px-3 py-1.5 transition-colors hover:bg-muted/40 disabled:opacity-50"
            >
              {t.settings.common.next}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
