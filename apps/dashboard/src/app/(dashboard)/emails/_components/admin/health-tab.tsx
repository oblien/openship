"use client";

/**
 * Health tab - single place to answer "is everything working?"
 *
 * Two sections operators check in different troubleshooting flows but
 * want to see together:
 *
 *   1. Daemons   - live state of Postfix, Dovecot, Amavis, ClamAV, etc, read from
 *                  whichever supervisor the box runs (supervisord in the engine
 *                  container, or systemd on a legacy host). Polled every 10 s.
 *                  Check this when "mail isn't sending" - usually a daemon is down.
 *   2. Outbound  - where this server hands mail off, and what the queue
 *                  says about it. Rides the same poll as the daemons.
 *                  Check this when the daemons are green and mail still
 *                  isn't arriving - a wrong relay password looks exactly
 *                  like a healthy box until you read the queue.
 *   3. DNS scan  - live public-DNS lookup for every record the install
 *                  expected the operator to publish. Compares actual
 *                  values against expected and reports pass/warn/fail.
 *                  Check this when "mail sends but lands in spam" or
 *                  "Gmail/Outlook reject with PTR/SPF errors".
 *
 * A header banner aggregates all three into one verdict.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CircleX,
  Clock,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Play,
  RefreshCcw,
  RotateCw,
  ScrollText,
  Search,
  Send,
  ShieldAlert,
  Square,
  Unplug,
} from "lucide-react";
import {
  mailAdminApi,
  mailApi,
  type ComponentAction,
  type DnsCheck,
  type DnsCheckStatus,
  type DnsScanResult,
  type MailComponentHealth,
  type MailComponentStatus,
  type MailDeferral,
  type MailDeferralKind,
  type MailDeliveryHealth,
  type MailDeliveryStatus,
  type MailPortReachability,
  type MailPortReachabilityCheck,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { SectionCard } from "./_shared/section-card";
import { Skeleton } from "./_shared/skeleton";
import { StatusPill, type PillTone } from "./_shared/status-pill";
import { LogsDrawer } from "./_shared/logs-drawer";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";
import { summarizeHealth, type HealthDict } from "../../_lib/health-summary";

const HEALTH_POLL_MS = 10_000;

export function HealthTab({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  // Heading lives in the page header in mail view — see ../../_lib/mail-section.
  const hoisted = useMailRailOwnsTabs(serverId);
  const [components, setComponents] = useState<MailComponentHealth[] | null>(null);
  // Same response as the daemons, so the same poll and the same error banner —
  // the send path is a second reading off one connection, not a second request.
  const [delivery, setDelivery] = useState<MailDeliveryHealth | null>(null);
  const [reachability, setReachability] = useState<MailPortReachability | null>(null);
  const [reachabilityRefreshing, setReachabilityRefreshing] = useState(false);
  const [componentsErr, setComponentsErr] = useState<string | null>(null);
  const [componentsLastUpdated, setComponentsLastUpdated] = useState<number | null>(null);

  const [dns, setDns] = useState<DnsScanResult | null>(null);
  const [dnsErr, setDnsErr] = useState<string | null>(null);
  const [dnsRefreshing, setDnsRefreshing] = useState(false);

  const tickComponents = useCallback(async (refreshReachability = false) => {
    try {
      const r = await mailApi.getHealth(serverId, refreshReachability);
      setComponents(r.components);
      setDelivery(r.delivery);
      setReachability(r.reachability);
      setComponentsErr(null);
      setComponentsLastUpdated(Date.now());
    } catch (err) {
      setComponentsErr(err instanceof Error ? err.message : t.emailsAdmin.health.healthCheckFailed);
    }
  }, [serverId]);

  const tickDns = useCallback(async () => {
    try {
      const r = await mailAdminApi.dns.scan(serverId);
      setDns(r);
      setDnsErr(null);
    } catch (err) {
      setDnsErr(err instanceof Error ? err.message : t.emailsAdmin.health.scanFailed);
    }
  }, [serverId]);

  // Poll daemon health on a timer; DNS scan only on demand (it's slower
  // and the records don't change minute-to-minute).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await tickComponents();
    };
    void tick();
    void tickDns();
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void tick();
    }, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tickComponents, tickDns]);

  const onRescan = async () => {
    if (dnsRefreshing) return;
    setDnsRefreshing(true);
    try {
      await tickDns();
    } finally {
      setDnsRefreshing(false);
    }
  };

  const onReachabilityRefresh = async () => {
    if (reachabilityRefreshing) return;
    setReachabilityRefreshing(true);
    try {
      await tickComponents(true);
    } finally {
      setReachabilityRefreshing(false);
    }
  };

  const summary = summarizeHealth(
    components,
    dns?.checks ?? null,
    delivery,
    t.emailsAdmin.health,
    reachability,
  );

  return (
    <div className="space-y-5">
      {!hoisted && (
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.health.heading}</h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
            {t.emailsAdmin.health.description}
          </p>
        </div>
      )}

      {summary && (
        <div
          className={`rounded-2xl border ${summary.banner} flex items-center gap-4 px-5 py-4`}
        >
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${summary.iconBg}`}
          >
            <summary.Icon
              className={`size-5 ${summary.iconColor}`}
              strokeWidth={2}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-semibold ${summary.textColor}`}>
              {summary.label}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{summary.sub}</p>
          </div>
        </div>
      )}

      {/* ── Daemons ───────────────────────────────────────────────────── */}
      <SectionCard
        title={t.emailsAdmin.health.daemonsTitle}
        description={t.emailsAdmin.health.daemonsDesc}
        density="split"
        icon={Activity}
        action={
          componentsLastUpdated && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {interpolate(t.emailsAdmin.health.updated, { time: timeAgo(componentsLastUpdated, t.emailsAdmin.health.time) })}
            </span>
          )
        }
      >
        {componentsErr && (
          <div className="px-5 py-3 text-sm text-danger border-b border-border/40 bg-danger-bg">
            {componentsErr}
          </div>
        )}
        {components === null && !componentsErr ? (
          <DaemonsSkeleton />
        ) : components ? (
          <div className="divide-y divide-border/40">
            {components.map((c) => (
              <DaemonRow
                key={c.key}
                component={c}
                serverId={serverId}
                onActed={tickComponents}
              />
            ))}
          </div>
        ) : null}
      </SectionCard>

      <ReachabilitySection
        reachability={reachability}
        error={componentsErr}
        refreshing={reachabilityRefreshing}
        onRefresh={onReachabilityRefresh}
      />

      {/* ── Outbound delivery ─────────────────────────────────────────────
          Hidden only until the first reading lands, and only if that first
          reading failed — the error is already shown above, and an empty card
          would read as "nothing is queued". Later failures keep the last
          reading on screen, like the daemon rows do. */}
      {(delivery || !componentsErr) && (
        <DeliverySection delivery={delivery} />
      )}

      {/* ── DNS scan ──────────────────────────────────────────────────── */}
      <SectionCard
        title={t.emailsAdmin.health.dnsScanTitle}
        description={
          dns?.domain
            ? interpolate(t.emailsAdmin.health.dnsScanDescFor, { domain: dns.domain })
            : t.emailsAdmin.health.dnsScanDesc
        }
        density="split"
        icon={Search}
        action={
          <button
            onClick={onRescan}
            disabled={dnsRefreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
          >
            <RefreshCcw
              className={`size-3 ${dnsRefreshing ? "animate-spin" : ""}`}
            />
            {t.emailsAdmin.health.rescan}
          </button>
        }
      >
        {dnsErr && (
          <div className="px-5 py-3 text-sm text-danger border-b border-border/40 bg-danger-bg">
            {dnsErr}
          </div>
        )}
        {dns === null && !dnsErr ? (
          <DnsScanSkeleton />
        ) : dns && dns.checks.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Globe
              className="size-7 text-muted-foreground/60 mx-auto mb-3"
              strokeWidth={1.5}
            />
            <p className="text-sm text-muted-foreground">
              {t.emailsAdmin.health.dnsEmpty}
            </p>
          </div>
        ) : dns ? (
          <div className="divide-y divide-border/40">
            {dns.checks.map((c) => (
              <DnsCheckRow key={c.key} check={c} />
            ))}
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

export function ReachabilitySection({
  reachability,
  error,
  refreshing,
  onRefresh,
}: {
  reachability: MailPortReachability | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const h = t.emailsAdmin.health;
  const providerBlocked =
    reachability?.status === "fail" &&
    reachability.ports.some((port) => port.status === "blocked");
  return (
    <SectionCard
      title={h.reachability.title}
      description={
        reachability?.address
          ? interpolate(h.reachability.descFor, {
              hostname: reachability.hostname,
              address: reachability.address,
            })
          : h.reachability.desc
      }
      density="split"
      icon={Globe}
      action={
        <div className="flex items-center gap-3">
          {reachability && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {interpolate(h.updated, { time: timeAgo(reachability.checkedAt, h.time) })}
            </span>
          )}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
          >
            <RefreshCcw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
            {h.rescan}
          </button>
        </div>
      }
    >
      {!reachability && !error ? (
        <ReachabilitySkeleton />
      ) : reachability ? (
        <>
          {providerBlocked && (
            <div className="px-5 py-3 text-sm text-danger border-b border-danger-border bg-danger-bg">
              {h.reachability.remediation}
            </div>
          )}
          {reachability.status === "unknown" && reachability.detail && (
            <div className="px-5 py-3 text-sm text-warning border-b border-warning-border bg-warning-bg">
              {reachability.detail}
            </div>
          )}
          <div className="divide-y divide-border/40">
            {reachability.ports.map((port) => (
              <ReachabilityRow
                key={port.key}
                port={port}
                unverified={reachability.status === "unknown" && port.status === "blocked"}
              />
            ))}
          </div>
        </>
      ) : null}
    </SectionCard>
  );
}

function ReachabilityRow({
  port,
  unverified,
}: {
  port: MailPortReachabilityCheck;
  unverified: boolean;
}) {
  const { t } = useI18n();
  const copy = t.emailsAdmin.health.reachability;
  // Keep the raw failed probe in the API response, but do not present an
  // ambiguous SMTP timeout as a confirmed inbound firewall failure.
  const displayStatus = unverified ? "unknown" : port.status;
  const status = reachabilityPresentation(displayStatus);
  const detail =
    displayStatus === "reachable"
      ? copy.reachableHint
      : displayStatus === "blocked"
        ? port.failure === "timeout"
          ? copy.blockedTimeoutHint
          : copy.blockedHint
        : displayStatus === "not_listening"
          ? copy.notListeningHint
          : displayStatus === "not_exposed"
            ? copy.notExposedHint
            : port.detail || copy.unknownHint;

  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${status.iconBg}`}>
        <status.Icon className={`size-5 ${status.iconColor}`} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground">{copy.ports[port.key]}</p>
          <span className="font-mono text-[11px] text-muted-foreground">TCP {port.port}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
      </div>
      <StatusPill tone={status.tone}>{copy.status[displayStatus]}</StatusPill>
    </div>
  );
}

function reachabilityPresentation(status: MailPortReachabilityCheck["status"]): {
  Icon: typeof CheckCircle2;
  iconBg: string;
  iconColor: string;
  tone: PillTone;
} {
  if (status === "reachable") {
    return { Icon: CheckCircle2, iconBg: "bg-success-bg", iconColor: "text-success", tone: "success" };
  }
  if (status === "unknown") {
    return { Icon: CircleDashed, iconBg: "bg-muted", iconColor: "text-muted-foreground", tone: "neutral" };
  }
  return { Icon: Unplug, iconBg: "bg-danger-bg", iconColor: "text-danger", tone: "danger" };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/**
 * Daemon row - every row exposes Logs directly and a 3-dot menu with the
 * status-aware lifecycle actions (start / stop / restart). "Missing" units
 * have no menu since there's nothing to act on.
 */
function DaemonRow({
  component,
  serverId,
  onActed,
}: {
  component: MailComponentHealth;
  serverId: string;
  onActed: () => void;
}) {
  const { t, dir } = useI18n();
  const h = t.emailsAdmin.health;
  const presentation = daemonStatusPresentation(component.status);
  const statusLabel = daemonStatusLabel(component.status, h, component.subState);
  const subStateHint = daemonSubStateHint(component, h);
  const { showToast } = useToast();
  const [acting, setActing] = useState<ComponentAction | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);

  const run = async (action: ComponentAction) => {
    if (acting) return;
    setActing(action);
    try {
      const res = await mailAdminApi.components.action(serverId, component.key, action);
      // Refresh BEFORE toasting so the pill and the toast can't contradict each other.
      await onActed();
      const wanted = action === "stop" ? "inactive" : "active";
      if (!res.settled || res.settled.status === wanted) {
        const doneTpl =
          action === "start" ? h.toast.started : action === "stop" ? h.toast.stopped : h.toast.restarted;
        showToast(interpolate(doneTpl, { label: component.label }), "success");
      } else {
        // The supervisor took the job and the daemon still isn't there. "ClamAV
        // restarted" for a daemon already back in BACKOFF is the lie this removes.
        // `res.output` is the supervisor's own words (e.g. "ERROR (not running)"),
        // server-generated, so it is appended verbatim and untranslated. A settled
        // state that is still transitional arrives as undefined, so a healthy slow
        // restart keeps the optimistic wording above.
        const sentence = interpolate(h.toast.notConfirmed, {
          label: component.label,
          state: daemonStatusLabel(res.settled.status, h, res.settled.subState),
        });
        showToast(
          res.output ? `${sentence} ${res.output}` : sentence,
          "info",
          interpolate(h.toast.notConfirmedTitle, { label: component.label }),
        );
      }
    } catch (err) {
      const failMsg =
        action === "start" ? h.toast.startFailed : action === "stop" ? h.toast.stopFailed : h.toast.restartFailed;
      const failTitleTpl =
        action === "start"
          ? h.toast.startFailedTitle
          : action === "stop"
            ? h.toast.stopFailedTitle
            : h.toast.restartFailedTitle;
      showToast(
        err instanceof Error ? err.message : failMsg,
        "error",
        interpolate(failTitleTpl, { label: component.label }),
      );
    } finally {
      setActing(null);
    }
  };

  const menuActions: MenuAction[] = (() => {
    if (component.status === "missing") return [];
    const items: MenuAction[] = [];
    const isRunning =
      component.status === "active" || component.status === "activating";
    if (isRunning) {
      items.push({
        id: "restart",
        label: acting === "restart" ? h.menu.restarting : h.menu.restart,
        icon: <RotateCw className="size-4" strokeWidth={2.25} />,
        onClick: () => void run("restart"),
        disabled: acting !== null,
      });
      items.push({
        id: "stop",
        label: acting === "stop" ? h.menu.stopping : h.menu.stop,
        icon: <Square className="size-4" strokeWidth={2.25} />,
        onClick: () => void run("stop"),
        disabled: acting !== null,
        variant: "danger",
      });
    } else {
      items.push({
        id: "start",
        label: acting === "start" ? h.menu.starting : h.menu.start,
        icon: <Play className="size-4" strokeWidth={2.25} />,
        onClick: () => void run("start"),
        disabled: acting !== null,
        variant: "success",
      });
      items.push({
        id: "restart",
        label: acting === "restart" ? h.menu.restarting : h.menu.restart,
        icon: <RotateCw className="size-4" strokeWidth={2.25} />,
        onClick: () => void run("restart"),
        disabled: acting !== null,
      });
    }
    return items;
  })();

  return (
    <>
      <div className="flex items-center gap-4 px-5 py-4">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${presentation.iconBg}`}
        >
          <presentation.Icon
            className={`size-5 ${presentation.iconColor}`}
            strokeWidth={2}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-foreground truncate">
              {component.label}
            </p>
            <span className="font-mono text-[11px] text-muted-foreground/80 truncate">
              {component.unit}
            </span>
            {/* Informational rows carry the same chip: from the operator's side both
                mean "mail still works without this". The difference is only whether the
                banner grades it (GH-240). */}
            {component.severity !== "required" && (
              <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground/70 border border-border/60 rounded px-1 py-px">
                {h.optional}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {component.description}
          </p>
          {component.activeSince && component.status === "active" && (
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              {interpolate(h.up, { time: timeAgo(new Date(component.activeSince).getTime(), h.time) })}
            </p>
          )}
          {/* The probe's own words for an undetermined state. Server-generated
              (docker/supervisord output), so it is not a translation key. */}
          {component.detail && (
            <p className="text-[11px] text-warning mt-0.5 break-words">
              {component.detail}
            </p>
          )}
          {subStateHint && (
            <p className="text-[11px] text-danger mt-0.5 break-words">{subStateHint}</p>
          )}
        </div>
        <StatusPill tone={presentation.tone} icon={presentation.PillIcon}>
          {statusLabel}
        </StatusPill>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setLogsOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            title={h.openLogs}
          >
            <ScrollText className="size-3.5" strokeWidth={2.25} />
            {h.logs}
          </button>
          {menuActions.length > 0 && (
            <DropdownMenu
              actions={menuActions}
              align={dir === "rtl" ? "left" : "right"}
              disabled={acting !== null}
              triggerClassName="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-60"
              trigger={
                acting ? (
                  <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
                ) : undefined
              }
            />
          )}
        </div>
      </div>
      {logsOpen && (
        <LogsDrawer
          serverId={serverId}
          componentKey={component.key}
          label={component.label}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </>
  );
}

// ─── Outbound delivery ───────────────────────────────────────────────────────

/**
 * Where mail leaves this box, and what the queue says about it.
 *
 * Rows follow the order an operator triages in: the hop, then the depth, then
 * the remote's own refusal. Deferral rows are all styled alike on purpose - the
 * verdict is the server's (`delivery.status`, in the pill), and re-deriving
 * severity per row here would be a second copy of the grading rule that is free
 * to drift from the one in `mail-delivery.service.ts`.
 */
function DeliverySection({ delivery }: { delivery: MailDeliveryHealth | null }) {
  const { t } = useI18n();
  const d = t.emailsAdmin.health.delivery;

  return (
    <SectionCard
      title={d.title}
      description={d.desc}
      density="split"
      icon={Send}
      action={
        delivery && (
          <StatusPill tone={DELIVERY_TONE[delivery.status]}>
            {d.status[delivery.status]}
          </StatusPill>
        )
      }
    >
      {delivery === null ? (
        <DeliverySkeleton />
      ) : (
        <div className="divide-y divide-border/40">
          <SendPathRow delivery={delivery} />
          {delivery.status === "unknown" ? (
            <DeliveryRow
              Icon={CircleDashed}
              iconBg="bg-muted"
              iconColor="text-muted-foreground"
              title={d.status.unknown}
              // The probe's own words for a reading we couldn't take.
              // Server-generated, so not a translation key.
              detail={delivery.detail}
            />
          ) : (
            <>
              <DeliveryRow
                Icon={delivery.queued > 0 ? Clock : Check}
                iconBg={delivery.queued > 0 ? "bg-warning-bg" : "bg-muted"}
                iconColor={
                  delivery.queued > 0 ? "text-warning" : "text-muted-foreground"
                }
                eyebrow={d.queue}
                title={
                  delivery.queued === 0
                    ? d.queueEmpty
                    : interpolate(
                        delivery.queued === 1 ? d.queueOne : d.queueOther,
                        { count: String(delivery.queued) },
                      )
                }
                note={delivery.sampled ? d.sampled : undefined}
              />
              {delivery.deferrals.length > 0 && (
                <div className="px-5 py-2.5 bg-muted/30">
                  <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
                    {d.reasons}
                  </p>
                </div>
              )}
              {delivery.deferrals.map((deferral) => (
                <DeferralRow
                  key={deferral.reason}
                  deferral={deferral}
                  mode={delivery.mode}
                />
              ))}
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function SendPathRow({ delivery }: { delivery: MailDeliveryHealth }) {
  const { t } = useI18n();
  const d = t.emailsAdmin.health.delivery;
  const relaying = delivery.mode === "relay";
  const domains = delivery.relayDomains ?? [];

  // Under `selected` scope the domain list IS the explanation, so with nothing
  // in it we say nothing rather than print "Only selected senders relay:".
  const sub = !relaying
    ? d.directHint
    : delivery.relayScope === "selected"
      ? domains.length > 0
        ? interpolate(d.relaySelected, { domains: domains.join(", ") })
        : undefined
      : d.relayAll;

  return (
    <DeliveryRow
      Icon={relaying ? Send : Globe}
      iconBg="bg-muted"
      iconColor="text-muted-foreground"
      eyebrow={d.sendPath}
      title={
        relaying
          ? interpolate(d.relay, { host: delivery.relayHost ?? "" })
          : d.direct
      }
      sub={sub}
    />
  );
}

function DeferralRow({
  deferral,
  mode,
}: {
  deferral: MailDeferral;
  mode: MailDeliveryHealth["mode"];
}) {
  const { t } = useI18n();
  const d = t.emailsAdmin.health.delivery;
  // An auth refusal on a relayed box can only be the relay credentials - the
  // relay is the only host we authenticate to - so that case names the fix.
  const hint =
    deferral.kind === "auth" && mode === "relay" ? d.hint.authRelay : d.hint[deferral.kind];

  return (
    <DeliveryRow
      Icon={DEFERRAL_ICON[deferral.kind]}
      iconBg="bg-warning-bg"
      iconColor="text-warning"
      title={d.kind[deferral.kind]}
      badge={interpolate(
        deferral.count === 1 ? d.affectedOne : d.affectedOther,
        { count: String(deferral.count) },
      )}
      sub={hint}
      // The remote's verbatim refusal - the one line that actually names the
      // cause, so it is shown as-is and never translated.
      reason={deferral.reason}
    />
  );
}

function DeliveryRow({
  Icon,
  iconBg,
  iconColor,
  eyebrow,
  title,
  badge,
  sub,
  reason,
  note,
  detail,
}: {
  Icon: typeof Check;
  iconBg: string;
  iconColor: string;
  eyebrow?: string;
  title: string;
  badge?: string;
  sub?: string;
  reason?: string;
  note?: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}
      >
        <Icon className={`size-5 ${iconColor}`} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground/80 mb-0.5">
            {eyebrow}
          </p>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground break-words">{title}</p>
          {badge && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {badge}
            </span>
          )}
        </div>
        {sub && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{sub}</p>
        )}
        {reason && (
          <p className="font-mono text-[11px] text-muted-foreground/80 mt-1.5 break-words leading-relaxed">
            {reason}
          </p>
        )}
        {note && <p className="text-[11px] text-muted-foreground/70 mt-1">{note}</p>}
        {detail && (
          <p className="text-[11px] text-warning mt-0.5 break-words">{detail}</p>
        )}
      </div>
    </div>
  );
}

function DnsCheckRow({ check }: { check: DnsCheck }) {
  const { t } = useI18n();
  const presentation = dnsStatusPresentation(check.status);
  const statusLabel = dnsStatusLabel(check.status, t.emailsAdmin.health);
  const showExpectedActual =
    (check.status === "warn" || check.status === "fail") && check.expected;
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${presentation.iconBg}`}
      >
        <presentation.Icon
          className={`size-5 ${presentation.iconColor}`}
          strokeWidth={2}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground">{check.label}</p>
          <span className="font-mono text-[11px] text-muted-foreground/80">
            {check.recordType} · {check.queriedName}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          {check.message}
        </p>
        {showExpectedActual && (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11.5px]">
            <RowKV label={t.emailsAdmin.health.expected} value={check.expected} />
            <RowKV
              label={t.emailsAdmin.health.actual}
              value={check.actual || t.emailsAdmin.health.noRecord}
              muted={!check.actual}
            />
          </div>
        )}
      </div>
      <StatusPill tone={presentation.tone}>{statusLabel}</StatusPill>
    </div>
  );
}

function RowKV({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-0.5">
        {label}
      </p>
      <p
        className={`font-mono break-all ${
          muted ? "text-muted-foreground/70 italic" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Skeletons ───────────────────────────────────────────────────────────────

function DaemonsSkeleton() {
  return (
    <div className="divide-y divide-border/40">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-72 max-w-full" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full shrink-0" />
        </div>
      ))}
    </div>
  );
}

function DeliverySkeleton() {
  return (
    <div className="divide-y divide-border/40">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="flex items-start gap-4 px-5 py-4">
          <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-2 w-16" />
            <Skeleton className="h-3 w-52 max-w-full" />
            <Skeleton className="h-2.5 w-72 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ReachabilitySkeleton() {
  return (
    <div className="divide-y divide-border/40">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-48 max-w-full" />
            <Skeleton className="h-2.5 w-72 max-w-full" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full shrink-0" />
        </div>
      ))}
    </div>
  );
}

function DnsScanSkeleton() {
  return (
    <div className="divide-y divide-border/40">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-start gap-4 px-5 py-4">
          <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-2.5 w-64 max-w-full" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ─── Status mappings ─────────────────────────────────────────────────────────

interface StatusPresentation {
  Icon: typeof Check;
  PillIcon: typeof Check;
  iconBg: string;
  iconColor: string;
  tone: PillTone;
  label: string;
}

function daemonStatusPresentation(status: MailComponentStatus): StatusPresentation {
  switch (status) {
    case "active":
      return {
        Icon: Check,
        PillIcon: Check,
        iconBg: "bg-success-bg",
        iconColor: "text-success",
        tone: "success",
        label: "Running",
      };
    case "activating":
      return {
        Icon: Loader2,
        PillIcon: Loader2,
        iconBg: "bg-info-bg",
        iconColor: "text-info animate-spin",
        tone: "info",
        label: "Starting",
      };
    case "deactivating":
      return {
        Icon: Loader2,
        PillIcon: Loader2,
        iconBg: "bg-warning-bg",
        iconColor: "text-warning animate-spin",
        tone: "warning",
        label: "Stopping",
      };
    case "inactive":
      return {
        Icon: CircleDashed,
        PillIcon: CircleDashed,
        iconBg: "bg-muted",
        iconColor: "text-muted-foreground",
        tone: "neutral",
        label: "Stopped",
      };
    case "failed":
      return {
        Icon: CircleX,
        PillIcon: CircleX,
        iconBg: "bg-danger-bg",
        iconColor: "text-danger",
        tone: "danger",
        label: "Failed",
      };
    case "missing":
      return {
        Icon: CircleAlert,
        PillIcon: CircleAlert,
        iconBg: "bg-warning-bg",
        iconColor: "text-warning",
        tone: "warning",
        label: "Missing",
      };
    default:
      return {
        Icon: CircleDashed,
        PillIcon: CircleDashed,
        iconBg: "bg-muted",
        iconColor: "text-muted-foreground",
        tone: "neutral",
        label: "Unknown",
      };
  }
}

/** The card's pill. The server already graded it; this only picks the colour. */
const DELIVERY_TONE: Record<MailDeliveryStatus, PillTone> = {
  ok: "success",
  warn: "warning",
  fail: "danger",
  unknown: "neutral",
};

const DEFERRAL_ICON: Record<MailDeferralKind, typeof Check> = {
  auth: KeyRound,
  tls: Lock,
  network: Unplug,
  rejected: ShieldAlert,
  other: CircleAlert,
};

interface DnsStatusPresentation {
  Icon: typeof Check;
  iconBg: string;
  iconColor: string;
  tone: PillTone;
  label: string;
}

function dnsStatusPresentation(status: DnsCheckStatus): DnsStatusPresentation {
  switch (status) {
    case "pass":
      return {
        Icon: Check,
        iconBg: "bg-success-bg",
        iconColor: "text-success",
        tone: "success",
        label: "Pass",
      };
    case "warn":
      return {
        Icon: AlertTriangle,
        iconBg: "bg-warning-bg",
        iconColor: "text-warning",
        tone: "warning",
        label: "Warning",
      };
    case "fail":
      return {
        Icon: CircleX,
        iconBg: "bg-danger-bg",
        iconColor: "text-danger",
        tone: "danger",
        label: "Fail",
      };
    default:
      return {
        Icon: CircleDashed,
        iconBg: "bg-muted",
        iconColor: "text-muted-foreground",
        tone: "neutral",
        label: "Unknown",
      };
  }
}

// ─── Status label maps (localized) ───────────────────────────────────────────

function daemonStatusLabel(
  status: MailComponentStatus,
  h: HealthDict,
  subState?: string,
): string {
  switch (status) {
    case "active":
      return h.daemonStatus.running;
    case "activating":
      return h.daemonStatus.starting;
    case "deactivating":
      return h.daemonStatus.stopping;
    case "inactive":
      return h.daemonStatus.stopped;
    // supervisord collapses FATAL (given up) and BACKOFF (still retrying) into one
    // `failed`; only the sub-state separates them, and only one of them needs the
    // operator to press Restart.
    case "failed":
      return subState === "fatal" ? h.daemonStatus.crashed : h.daemonStatus.failed;
    case "missing":
      return h.daemonStatus.missing;
    default:
      return h.daemonStatus.unknown;
  }
}

/**
 * The one thing `failed` doesn't say: whether anything is still trying.
 *
 * Matches the LOWER-CASED supervisord word (mail-engine.ts lower-cases the container
 * arm); systemd has no FATAL/BACKOFF, so the host flavor never hits either branch.
 */
function daemonSubStateHint(component: MailComponentHealth, h: HealthDict): string | null {
  if (component.status !== "failed") return null;
  if (component.subState === "fatal") return h.daemonHint.fatal;
  if (component.subState === "backoff") return h.daemonHint.backoff;
  return null;
}

function dnsStatusLabel(status: DnsCheckStatus, h: HealthDict): string {
  switch (status) {
    case "pass":
      return h.dnsStatus.pass;
    case "warn":
      return h.dnsStatus.warning;
    case "fail":
      return h.dnsStatus.fail;
    default:
      return h.dnsStatus.unknown;
  }
}

function timeAgo(ts: number, tt: HealthDict["time"]): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.round(diff / 1000);
  if (s < 60) return interpolate(tt.secondsAgo, { n: String(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return interpolate(tt.minutesAgo, { n: String(m) });
  const h = Math.floor(m / 60);
  if (h < 24) return interpolate(tt.hoursAgo, { n: String(h) });
  return interpolate(tt.daysAgo, { n: String(Math.floor(h / 24)) });
}
