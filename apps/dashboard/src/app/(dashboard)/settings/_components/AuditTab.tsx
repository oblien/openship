"use client";

/**
 * Audit log page — filterable feed of who-did-what for the active org.
 *
 * Backed by GET /api/audit (admin-only). Supports filtering by:
 *   - event type        (deployment.succeeded, member.invited, etc.)
 *   - actor             (specific user in the org)
 *   - resource          (specific project / deployment / server)
 *   - free-text search  (client-side, on the loaded page)
 *
 * Rows are clickable — clicking opens a details modal with the full
 * audit row payload (actor, resource, before/after diff, IP, UA).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Filter, User as UserIcon, Copy, Check } from "lucide-react";
import { api } from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import { AUDIT_EVENT_LABELS, getAuditLabel } from "@/lib/audit-labels";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface AuditActor {
  id: string;
  email?: string | null;
  name?: string | null;
}

interface AuditEvent {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  /**
   * Resolved actor — joined from the user table on the server in one
   * batched lookup per request. Null when the actor was a system
   * process or the user row has since been deleted.
   */
  actor: AuditActor | null;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/**
 * Best-effort display name for an audit row's actor. Prefers full name,
 * falls back to email, then to the raw user id (which is rarely seen —
 * only when both columns are empty on the user row).
 */
function actorDisplay(
  e: AuditEvent,
  labels: { system: string; actorPrefix: string },
): string {
  if (e.actor) {
    if (e.actor.name && e.actor.name.trim()) return e.actor.name;
    if (e.actor.email) return e.actor.email;
    return e.actor.id.slice(0, 8);
  }
  if (e.actorUserId) return interpolate(labels.actorPrefix, { id: e.actorUserId.slice(0, 8) });
  return labels.system;
}

/**
 * Filter dropdown — pre-populated with the most common event types
 * from the label catalog. The full list is far too long for a
 * dropdown; this is a curated short-list of high-signal events.
 */
const EVENT_TYPE_OPTIONS = (() => {
  const curated = [
    "deployment.succeeded",
    "deployment.failed",
    "deployment.canceled",
    "member.added",
    "member.removed",
    "member.role_changed",
    "invitation.created",
    "invitation.accepted",
    "project.created",
    "project.updated",
    "project.deleted",
    "server.added",
    "server.updated",
    "server.removed",
    "domain.added",
    "domain.removed",
    "settings.updated",
    "grant.granted",
    "grant.revoked",
    "github.disconnect",
    "billing.hard_cap_tripped",
  ];
  return [
    { value: "", label: "All events" },
    ...curated
      .filter((t) => t in AUDIT_EVENT_LABELS)
      .map((value) => ({ value, label: AUDIT_EVENT_LABELS[value].label })),
  ];
})();

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
  const date = new Date(iso);
  return date.toLocaleString();
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Details modal body                                                  */
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
  // Pretty-print with stable key order and a 2-space indent.
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

function AuditDetailsBody({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const { t } = useI18n();
  const labelInfo = getAuditLabel(event.eventType);
  const hasBefore = event.before !== null && event.before !== undefined;
  const hasAfter = event.after !== null && event.after !== undefined;

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">{labelInfo.label}</h2>
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            title={absoluteTime(event.createdAt)}
          >
            {relativeTime(event.createdAt)} · {absoluteTime(event.createdAt)}
          </p>
          {labelInfo.description && (
            <p className="mt-2 text-sm text-muted-foreground">{labelInfo.description}</p>
          )}
          <p className="mt-2 inline-block rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {event.eventType}
          </p>
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

      {/* Actor */}
      <section className="rounded-xl border border-border/50 bg-card p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t.settings.audit.actor}
        </h3>
        <DetailRow label={t.settings.audit.name} value={event.actor?.name || (event.actor ? "—" : t.settings.audit.system)} />
        <DetailRow label={t.settings.audit.email} value={event.actor?.email || "—"} />
        <DetailRow
          label={t.settings.audit.userId}
          value={event.actorUserId || "—"}
          copyable={!!event.actorUserId}
          mono
        />
        <DetailRow label={t.settings.audit.ip} value={event.ipAddress || "—"} copyable={!!event.ipAddress} mono />
        <DetailRow
          label={t.settings.audit.userAgent}
          value={event.userAgent ? event.userAgent.slice(0, 200) : "—"}
        />
      </section>

      {/* Resource */}
      {(event.resourceType || event.resourceId) && (
        <section className="rounded-xl border border-border/50 bg-card p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t.settings.audit.resource}
          </h3>
          <DetailRow label={t.settings.audit.type} value={event.resourceType || "—"} mono />
          <DetailRow
            label={t.settings.audit.id}
            value={event.resourceId || "—"}
            copyable={!!event.resourceId}
            mono
          />
        </section>
      )}

      {/* Changes */}
      {(hasBefore || hasAfter) && (
        <section className="rounded-xl border border-border/50 bg-card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
        </section>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Page                                                                */
/* ──────────────────────────────────────────────────────────────────── */

export function AuditTab() {
  const { t } = useI18n();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [eventType, setEventType] = useState("");
  const [search, setSearch] = useState("");
  const { showModal, hideModal } = useModal();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: AuditEvent[]; total: number }>("audit", {
        params: { page, perPage: 50, eventType: eventType || undefined },
      });
      setEvents(res.data);
      setTotal(res.total);
    } catch (err) {
      console.error("Failed to load audit events", err);
      setEvents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [eventType, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return events;
    const q = search.toLowerCase();
    return events.filter(
      (e) =>
        e.eventType.toLowerCase().includes(q) ||
        e.resourceId?.toLowerCase().includes(q) ||
        e.actorUserId?.toLowerCase().includes(q) ||
        e.actor?.email?.toLowerCase().includes(q) ||
        e.actor?.name?.toLowerCase().includes(q),
    );
  }, [events, search]);

  const openDetails = useCallback(
    (event: AuditEvent) => {
      // Capture the modal id so the body's close button can dismiss
      // this exact instance even if other modals are pushed on top.
      let modalId = "";
      modalId = showModal({
        maxWidth: "720px",
        showCloseButton: true,
        customContent: (
          <AuditDetailsBody event={event} onClose={() => hideModal(modalId)} />
        ),
      });
    },
    [showModal, hideModal],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2
          className="text-xl font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          {t.settings.audit.heading}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t.settings.audit.subtitle}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.settings.audit.searchPlaceholder}
            className="w-full ps-10 pe-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
        <div className="relative">
          <Filter className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <select
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value);
              setPage(1);
            }}
            className="ps-10 pe-8 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          >
            {EVENT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value === "" ? t.settings.audit.allEvents : opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-border/50 bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {search ? t.settings.audit.noMatch : t.settings.audit.noEvents}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {filtered.map((e) => {
              const labelInfo = getAuditLabel(e.eventType);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => openDetails(e)}
                  className="w-full px-5 py-3.5 flex items-center gap-4 text-start hover:bg-muted/30 transition-colors focus:outline-none focus:bg-muted/40"
                >
                  <div className="w-8 h-8 rounded-full bg-muted/60 flex items-center justify-center shrink-0">
                    <UserIcon className="size-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {labelInfo.label}
                      </span>
                      {e.resourceId && (
                        <span className="text-xs text-muted-foreground font-mono truncate">
                          {e.resourceId.slice(0, 16)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      <span className="text-foreground/80 font-medium">
                        {actorDisplay(e, { system: t.settings.audit.system, actorPrefix: t.settings.audit.actorPrefix })}
                      </span>
                      {e.actor?.name && e.actor.email && (
                        <span className="ms-1.5">{e.actor.email}</span>
                      )}
                      {e.ipAddress && <span> - {e.ipAddress}</span>}
                    </p>
                  </div>
                  <time
                    className="text-xs text-muted-foreground shrink-0"
                    title={absoluteTime(e.createdAt)}
                  >
                    {relativeTime(e.createdAt)}
                  </time>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {total > 50 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {interpolate(t.settings.audit.showing, { from: String((page - 1) * 50 + 1), to: String(Math.min(page * 50, total)), total: String(total) })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="px-3 py-1.5 rounded-lg border border-border/50 hover:bg-muted/40 transition-colors disabled:opacity-50"
            >
              {t.settings.common.previous}
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 50 >= total || loading}
              className="px-3 py-1.5 rounded-lg border border-border/50 hover:bg-muted/40 transition-colors disabled:opacity-50"
            >
              {t.settings.common.next}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
