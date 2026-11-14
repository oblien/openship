"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback } from "react";
import { discoveryApi, type DiscoveryService, type DiscoveryStatus } from "@/lib/api";
import {
  isPermissionError,
  rescanFailureDetail,
  useServerDiscovery,
} from "@/hooks/useServerDiscovery";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { Switch } from "@/components/ui/Switch";
import DropdownMenu from "@/components/ui/DropdownMenu";

/**
 * Server container discovery (docs/docker-service-discovery-plan.md, step 6).
 *
 * The backend owns every routing/TLS decision; this card only renders state
 * and issues operator intent (enable/disable, rescan, suppress/unsuppress,
 * forget). Route chips derive from the CONFIRMED routing record — an applied
 * generation that matches the desired generation and no pending withdrawal —
 * never from a running container or a successful HTTP response.
 */

/**
 * Confirmed route phase for one service. Ordered so the most important truth
 * wins: a pending withdrawal outranks suppression, suppression outranks a
 * retained vhost, and "active" is reached ONLY with a matching applied
 * generation, no queued work, AND a currently running, observed backend —
 * the reconciler deliberately records `markApplied` after writing the
 * unavailable (503) vhost for a stopped backend, so matching generations
 * alone do NOT mean the route serves traffic. `discoveryEnabled` reflects
 * the server's settings: when discovery is off, every applied route is
 * retired outright (the reconciler's withdrawal stage) while the row keeps
 * its applied history — those services read as retired, not active.
 */
export type DiscoveryRoutePhase =
  | "withdrawing"
  | "suppressed"
  | "retired"
  | "retained"
  | "blocked"
  | "failed"
  | "reconciling"
  | "active"
  | "pending"
  | "unknown";

export function routePhase(s: DiscoveryService, opts: { discoveryEnabled?: boolean } = {}): DiscoveryRoutePhase {
  const discoveryEnabled = opts.discoveryEnabled ?? true;
  if (s.withdrawalPending) return "withdrawing";
  if (s.suppressed) return "suppressed";
  const appliedHistory = s.appliedGeneration > 0;
  if (!discoveryEnabled) {
    // Disabled: withdrawal already ran (or was never needed) — the route is
    // gone; certificate material is retained until forgotten.
    return appliedHistory ? "retired" : "unknown";
  }
  // Conflict state outranks every retention reading: the reconciler retires
  // BLOCKED routes OUTRIGHT (shouldRetainUnavailableVhost is false for
  // blocked) and then clears withdrawalPending — so for a blocked row a
  // cleared flag confirms REMOVAL, never a retained 503 vhost. Without this
  // check a missing/invalid blocked row would misread as "Unavailable".
  if (s.applyState === "blocked") return "blocked";
  if ((s.observationStatus === "missing" || s.observationStatus === "invalid") && appliedHistory) {
    // The backend is GONE and its retirement already ran — this branch is
    // reached only with withdrawalPending false, which the reconciler clears
    // AFTER the unavailable vhost write succeeds, so "retained" here is
    // confirmed routing truth.
    return "retained";
  }
  // Other operator states and in-flight work also outrank retention: a
  // STOPPED backend whose 503 write failed must read as failed, and one
  // whose write is still queued must read as reconciling — never
  // "Unavailable" before the retention actually succeeded.
  if (s.applyState === "error") return "failed";
  // A FIRST apply (no application history yet) reads as pending, not
  // "reconciling" — nothing is confirmed yet and nothing is being replaced.
  if (s.applyState === "pending" && s.appliedGeneration === 0) return "pending";
  if (s.desiredGeneration !== s.appliedGeneration) return "reconciling";
  if (s.applyState === "applied") {
    // markApplied is recorded ONLY after the edge write — serving upstream for
    // a running backend, unavailable (503) vhost for a stopped one — so both
    // outcomes below are confirmed.
    if (s.observationStatus === "observed" && s.containerRunning) return "active";
    if (appliedHistory) return "retained";
    return "unknown";
  }
  if (s.applyState === "pending") return "pending";
  return "unknown";
}

const PHASE_TONE: Record<DiscoveryRoutePhase, string> = {
  active: "bg-success/10 text-success",
  reconciling: "bg-info/10 text-info",
  pending: "bg-info/10 text-info",
  withdrawing: "bg-warning/10 text-warning",
  retired: "bg-muted/40 text-muted-foreground",
  retained: "bg-muted/40 text-muted-foreground",
  failed: "bg-danger/10 text-danger",
  blocked: "bg-warning/10 text-warning",
  suppressed: "bg-muted/40 text-muted-foreground",
  unknown: "bg-muted/40 text-muted-foreground",
};

export function DiscoveryCard({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const s = t.servers.discovery;
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const d = useServerDiscovery(serverId);

  const configured = !!d.status?.settings.enabled;

  const toggle = useCallback(
    (next: boolean) => {
      if (d.busyKey) return;
      const run = () =>
        void (async () => {
          const res = await d.runAction("configure", () => discoveryApi.configure(serverId, { enabled: next }));
          if (res.ok) {
            showToast(next ? s.toast.enabled : s.toast.disabled, "success", s.toastTitle);
          } else if (res.error) {
            showToast(res.permission ? s.permissionDenied : res.error, "error", s.toastTitle);
          }
        })();
      if (!next) {
        // Disabling retires every applied route (outright removal, certificates
        // retained) — never do that silently.
        const modalId = showModal({
          title: s.confirm.disableTitle,
          message: s.confirm.disableMessage,
          icon: "warning",
          width: "100%",
          maxWidth: "32rem",
          buttons: [
            { label: s.cancel, variant: "secondary", onClick: () => hideModal(modalId) },
            {
              label: s.confirm.disableConfirm,
              variant: "danger",
              onClick: () => {
                hideModal(modalId);
                run();
              },
            },
          ],
        });
        return;
      }
      run();
    },
    [d, serverId, s, showToast, showModal, hideModal],
  );

  const rescan = useCallback(() => {
    void (async () => {
      const res = await d.runRescan();
      if (res.ok) {
        showToast(s.toast.rescanDone, "success", s.toastTitle);
      } else if (res.error) {
        showToast(res.permission ? s.permissionDenied : res.error, "error", s.toastTitle);
      } else if (res.summary) {
        // HTTP 200 but the sweep reported stage/service failures — surface
        // them; a silent partial failure would read as success.
        showToast(
          interpolate(s.toast.rescanPartial, { detail: rescanFailureDetail(res.summary) }),
          "error",
          s.toastTitle,
        );
      }
    })();
  }, [d, s, showToast]);

  const serviceAction = useCallback(
    (kind: "suppress" | "unsuppress" | "forget", service: DiscoveryService) => {
      if (d.busyKey) return;
      const copy = {
        suppress: { title: s.confirm.suppressTitle, message: s.confirm.suppressMessage, confirm: s.confirm.suppressConfirm, done: s.toast.suppressed, variant: "danger" },
        unsuppress: null,
        forget: { title: interpolate(s.confirm.forgetTitle, { service: service.hostname }), message: s.confirm.forgetMessage, confirm: s.confirm.forgetConfirm, done: s.toast.forgotten, variant: "danger" },
      }[kind];

      const run = () =>
        void (async () => {
          const key = `${kind}:${service.serviceKey}`;
          const res = await d.runAction(key, () =>
            kind === "forget"
              ? discoveryApi.forget(serverId, service.serviceKey)
              : kind === "suppress"
                ? discoveryApi.suppress(serverId, service.serviceKey)
                : discoveryApi.unsuppress(serverId, service.serviceKey),
          );
          if (res.ok) {
            showToast(copy?.done ?? s.toast.unsuppressed, "success", s.toastTitle);
          } else if (res.error) {
            showToast(res.permission ? s.permissionDenied : res.error, "error", s.toastTitle);
          }
        })();

      if (copy) {
        const modalId = showModal({
          title: copy.title,
          message: copy.message,
          icon: "warning",
          width: "100%",
          maxWidth: "32rem",
          buttons: [
            { label: s.cancel, variant: "secondary", onClick: () => hideModal(modalId) },
            {
              label: copy.confirm,
              variant: copy.variant as "danger",
              onClick: () => {
                hideModal(modalId);
                run();
              },
            },
          ],
        });
        return;
      }
      run();
    },
    [d, serverId, s, showToast, showModal, hideModal],
  );

  const services = d.status?.services ?? [];

  return (
    <div className="bg-card rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
        <div className="flex min-w-0 items-center gap-3">
          <div className="w-9 h-9 bg-info/10 rounded-xl flex items-center justify-center">
            <UiIcon name="docker" className="size-[18px] text-info" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]">{s.title}</h2>
            <p className="text-xs text-muted-foreground">{s.subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {configured && (
            <button
              type="button"
              onClick={rescan}
              disabled={d.busyKey !== null || d.rescanning}
              title={d.busyKey ? s.busyHint : undefined}
              className="inline-flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UiIcon name={d.rescanning ? "spinner" : "refresh"} className={`size-3.5 ${d.rescanning ? "animate-spin" : ""}`} />
              {d.rescanning ? s.rescanning : s.rescan}
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-muted-foreground">
              {configured ? s.enabledLabel : s.disabledLabel}
            </span>
            <Switch checked={configured} onChange={toggle} disabled={d.busyKey !== null} ariaLabel={s.title} />
          </div>
        </div>
      </div>

      <div className="p-5">
        {d.permissionDenied ? (
          <EmptyLine icon="eye-off" text={s.permissionDenied} />
        ) : d.error ? (
          <RetryLine text={d.error} retryLabel={s.retry} onRetry={() => void d.refresh()} />
        ) : d.loading ? (
          <SkeletonRows />
        ) : !d.status ? null : (
          <div className="space-y-4">
            {(d.status.settings.lastScanError || d.status.settings.lastScanAt) && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
                <span>
                  {d.status.settings.lastScanAt
                    ? interpolate(s.lastScan, { time: timeAgoShort(d.status.settings.lastScanAt) })
                    : s.neverScanned}
                </span>
                {d.reconciling && (
                  <span className="inline-flex items-center gap-1.5 text-info">
                    <UiIcon name="spinner" className="size-3 animate-spin" />
                    {s.reconciling}
                  </span>
                )}
              </div>
            )}
            {d.status.settings.lastScanError && (
              <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
                <p className="text-[12px] font-medium text-foreground">{s.scanFailedLabel}</p>
                <p className="mt-1 text-[12px] text-muted-foreground break-words">{d.status.settings.lastScanError}</p>
              </div>
            )}
            {services.length === 0 ? (
              <EmptyLine icon="docker" text={configured ? s.emptyHint : s.disabledHint} />
            ) : (
              <ul className="space-y-3">
                {services.map((service) => (
                  <ServiceRow
                    key={service.serviceKey}
                    service={service}
                    busyKey={d.busyKey}
                    discoveryEnabled={d.status?.settings.enabled ?? false}
                    onAction={(kind) => serviceAction(kind, service)}
                  />
                ))}
              </ul>
            )}
            <LifecycleNotes />
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceRow({
  service,
  busyKey,
  discoveryEnabled,
  onAction,
}: {
  service: DiscoveryService;
  busyKey: string | null;
  discoveryEnabled: boolean;
  onAction: (kind: "suppress" | "unsuppress" | "forget") => void;
}) {
  const { t } = useI18n();
  const s = t.servers.discovery;
  const phase = routePhase(service, { discoveryEnabled });
  const backend = backendState(service);

  return (
    <li className="rounded-xl bg-card p-4 border border-border/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate max-w-full">{service.hostname}</span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${PHASE_TONE[phase]}`}>
              {s.routeState[phase]}
            </span>
            {service.tls && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <UiIcon name={service.tls.verified ? "verified" : "lock"} className="size-3" />
                {tlsLabel(service, s.tlsState)}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground truncate">
            {service.containerName ?? service.serviceKey}
            {service.composeProject && service.composeService
              ? ` · ${service.composeProject}/${service.composeService}`
              : ""}
            {" · "}
            {service.port ? `:${service.port}` : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span
                className={`inline-block size-1.5 rounded-full ${service.containerRunning ? "bg-success" : "bg-muted-foreground/50"}`}
                aria-hidden
              />
              {s.backend[backend]}
            </span>
            {service.networkName && <span>{service.networkName}</span>}
            <span>
              {service.upstreamStrategy
                ? `${s.strategy[service.upstreamStrategy as "network-ip" | "published-port"]} · ${service.ipAddress ?? "?"}${service.hostPort ? `:${service.hostPort}` : ""}`
                : s.upstreamUnresolved}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {busyKey === `forget:${service.serviceKey}` || busyKey === `suppress:${service.serviceKey}` || busyKey === `unsuppress:${service.serviceKey}` ? (
            <UiIcon name="spinner" className="size-4 animate-spin text-muted-foreground" />
          ) : null}
          <DropdownMenu
            triggerLabel={s.actionsLabel}
            actions={[
              service.suppressed
                ? { id: "unsuppress", label: s.serviceLabel.unsuppress, icon: <UiIcon name="check" className="size-4" />, onClick: () => onAction("unsuppress") }
                : { id: "suppress", label: s.serviceLabel.suppress, icon: <UiIcon name="eye-off" className="size-4" />, onClick: () => onAction("suppress") },
              {
                id: "forget",
                label: s.serviceLabel.forget,
                icon: <UiIcon name="trash" className="size-4" />,
                variant: "danger" as const,
                onClick: () => onAction("forget"),
              },
            ]}
          />
        </div>
      </div>

      {(service.applyError || service.withdrawalPending) && (
        <div className="mt-3 space-y-1.5">
          {service.withdrawalPending && (
            <p className="text-[12px] text-warning">{s.routeHints.withdrawing}</p>
          )}
          {service.applyError && (
            <p className="text-[12px] text-danger break-words">
              {service.applyError}
              {service.applyAttempts > 0 && (
                <span className="text-muted-foreground">
                  {" · "}
                  {interpolate(s.retries, { count: String(service.applyAttempts) })}
                  {service.nextApplyAt
                    ? ` · ${interpolate(s.nextRetry, { time: new Date(service.nextApplyAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}`
                    : ""}
                </span>
              )}
            </p>
          )}
        </div>
      )}
      {phase === "retained" && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          {service.observationStatus === "invalid" ? s.routeHints.retainedInvalid : s.routeHints.retained}
        </p>
      )}
      {phase === "suppressed" && (
        <p className="mt-3 text-[12px] text-muted-foreground">{s.routeHints.suppressed}</p>
      )}
      {phase === "retired" && (
        <p className="mt-3 text-[12px] text-muted-foreground">{s.routeHints.retired}</p>
      )}
      {phase === "blocked" && (
        <p className="mt-3 text-[12px] text-muted-foreground">{s.routeHints.blocked}</p>
      )}
      {phase === "unknown" && (
        <p className="mt-3 text-[12px] text-muted-foreground">{s.routeHints.awaitingScan}</p>
      )}
    </li>
  );
}

function LifecycleNotes() {
  const { t } = useI18n();
  const s = t.servers.discovery.lifecycle;
  const notes = [s.stopRemove, s.disableSuppress, s.forget, s.rediscovery];
  return (
    <div className="rounded-xl bg-muted/20 px-4 py-3">
      <p className="text-[12px] font-medium text-muted-foreground">{s.title}</p>
      <ul className="mt-1.5 space-y-1">
        {notes.map((note, i) => (
          <li key={i} className="text-[12px] text-muted-foreground flex gap-2">
            <span className="mt-[7px] size-1 rounded-full bg-muted-foreground/50 shrink-0" aria-hidden />
            {note}
          </li>
        ))}
      </ul>
    </div>
  );
}

function backendState(s: DiscoveryService): "running" | "stopped" | "missing" | "invalid" {
  if (s.observationStatus === "missing") return "missing";
  if (s.observationStatus === "invalid") return "invalid";
  return s.containerRunning ? "running" : "stopped";
}

function tlsLabel(
  service: DiscoveryService,
  t: { verified: string; issued: string; provisioning: string; expired: string; error: string; none: string },
): string {
  // The domain row's sslStatus is written by the TLS lifecycle as
  // none | provisioning | active | expired | error — never "issued"/"pending".
  const tls = service.tls!;
  if (tls.sslStatus === "active" && tls.verified) return t.verified;
  if (tls.sslStatus === "active") return t.issued;
  if (tls.sslStatus === "provisioning") return t.provisioning;
  if (tls.sslStatus === "expired") return t.expired;
  if (tls.sslStatus === "error") return t.error;
  return t.none;
}

function timeAgoShort(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function EmptyLine({ icon, text }: { icon: "eye-off" | "docker"; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/20 px-4 py-6">
      <div className="w-9 h-9 bg-muted/40 rounded-xl flex items-center justify-center shrink-0">
        <UiIcon name={icon} className="size-[18px] text-muted-foreground" />
      </div>
      <p className="text-[13px] text-muted-foreground">{text}</p>
    </div>
  );
}

function RetryLine({ text, retryLabel, onRetry }: { text: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 flex items-center justify-between gap-4">
      <p className="text-[12px] text-foreground break-words min-w-0">{text}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 shrink-0"
      >
        <UiIcon name="refresh" className="size-3.5" />
        {retryLabel}
      </button>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3" role="status" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-xl bg-muted/20 p-4 animate-pulse">
          <div className="h-4 w-1/3 rounded bg-muted/60" />
          <div className="mt-2 h-3 w-1/2 rounded bg-muted/40" />
        </div>
      ))}
    </div>
  );
}

