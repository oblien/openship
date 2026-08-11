"use client";

/**
 * Team-mode migration wizard. Promotes a single_user instance into a
 * multi-user deployment via one of three paths:
 *
 *   - Server (A) — SSH-deploy openship onto the operator's own VPS.
 *                  Triggers /migration/preflight then /migration/start.
 *   - Cloud  (B) — push dump to api.openship.io. Triggers /start-cloud.
 *   - Tunnel (C) — keep data local, expose via Oblien edge tunnel.
 *                  Triggers /start-tunnel.
 *
 * The modal owns a three-step state machine: choose path → fill form →
 * show result. On success the dashboard rerenders the MigratedLauncher
 * automatically because /api/health/env now returns teamMode != single_user.
 */

import { useEffect, useState } from "react";
import { BlurIp } from "@/components/BlurIp";
import {
  Cloud,
  Loader2,
  Network,
  Server,
  X,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
} from "lucide-react";
import { migrationApi, systemApi, getApiErrorMessage } from "@/lib/api";
import type {
  DomainChoice,
  PreflightResult,
  StartServerResult,
  StartCloudResult,
  StartTunnelResult,
} from "@/lib/api/migration";
import type { ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useCloud } from "@/context/CloudContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";

type PathKind = "server" | "cloud" | "tunnel";
type Step = "choose" | "form" | "result";

interface MigrateModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful migration so the parent can refresh. */
  onMigrated: (url: string) => void;
}

export function MigrateModal({ open, onClose, onMigrated }: MigrateModalProps) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const { connected: cloudConnected } = useCloud();
  const [step, setStep] = useState<Step>("choose");
  const [path, setPath] = useState<PathKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultDetail, setResultDetail] = useState<string>("");

  // Reset everything on open so re-opens start clean.
  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setPath(null);
    setSubmitting(false);
    setResultUrl(null);
    setResultDetail("");
  }, [open]);

  if (!open) return null;

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSuccess = (url: string, detail: string) => {
    setResultUrl(url);
    setResultDetail(detail);
    setStep("result");
  };

  return (
    // Portal-backed shared Modal, not a hand-rolled `fixed inset-0` overlay.
    // Rendered inline, this sat INSIDE the settings page's stacking/filter
    // context, so the whole dialog came out washed and the page bled through it.
    // Modal portals to document.body and owns the scrim + solid surface.
    <Modal
      isOpen
      onClose={handleClose}
      closable={!submitting}
      showCloseButton={false}
      maxWidth="42rem"
      maxHeight="90vh"
      overflow="hidden"
    >
      <div className="flex max-h-[90vh] min-h-0 flex-col">
        <ModalHeader
          step={step}
          path={path}
          onBack={() => {
            if (step === "form") {
              setPath(null);
              setStep("choose");
            }
          }}
          onClose={handleClose}
          submitting={submitting}
        />

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {step === "choose" && (
            <ChooseStep
              cloudConnected={cloudConnected}
              onPick={(p) => {
                setPath(p);
                setStep("form");
              }}
            />
          )}

          {step === "form" && path === "server" && (
            <ServerForm
              submitting={submitting}
              onSubmitStart={() => setSubmitting(true)}
              onSubmitEnd={() => setSubmitting(false)}
              onSuccess={(res) =>
                handleSuccess(
                  res.migrationTargetUrl,
                  interpolate(t.settings.migrate.server.successDetail, { projectId: res.projectId }),
                )
              }
              showToast={showToast}
            />
          )}

          {step === "form" && path === "cloud" && (
            <CloudForm
              cloudConnected={cloudConnected}
              submitting={submitting}
              onSubmitStart={() => setSubmitting(true)}
              onSubmitEnd={() => setSubmitting(false)}
              onSuccess={(res) =>
                handleSuccess(
                  res.publicUrl,
                  interpolate(t.settings.migrate.cloud.successDetail, {
                    projects: String(res.imported.projects),
                    deployments: String(res.imported.deployments),
                    services: String(res.imported.services),
                  }),
                )
              }
              showToast={showToast}
            />
          )}

          {step === "form" && path === "tunnel" && (
            <TunnelForm
              cloudConnected={cloudConnected}
              submitting={submitting}
              onSubmitStart={() => setSubmitting(true)}
              onSubmitEnd={() => setSubmitting(false)}
              onSuccess={(res) =>
                handleSuccess(
                  res.migrationTargetUrl,
                  interpolate(t.settings.migrate.tunnel.successDetail, { slug: res.slug }),
                )
              }
              showToast={showToast}
            />
          )}

          {step === "result" && resultUrl && (
            <ResultStep
              url={resultUrl}
              detail={resultDetail}
              onDone={() => onMigrated(resultUrl)}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ─── Header ───────────────────────────────────────────────────────── */

function ModalHeader({
  step,
  path,
  onBack,
  onClose,
  submitting,
}: {
  step: Step;
  path: PathKind | null;
  onBack: () => void;
  onClose: () => void;
  submitting: boolean;
}) {
  const { t } = useI18n();
  const title =
    step === "choose"
      ? t.settings.migrate.chooseTitle
      : step === "form"
        ? path === "server"
          ? t.settings.migrate.serverTitle
          : path === "cloud"
            ? t.settings.migrate.cloudTitle
            : t.settings.migrate.tunnelTitle
        : t.settings.migrate.completeTitle;
  return (
    <div className="flex items-center gap-3 border-b border-border/50 px-6 py-4">
      {step === "form" && !submitting && (
        <button
          type="button"
          onClick={onBack}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
          title={t.settings.migrate.back}
        >
          <ChevronLeft className="size-4 rtl:rotate-180" />
        </button>
      )}
      <h2 className="text-base font-semibold text-foreground flex-1">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
        title={t.settings.common.close}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/* ─── Step 1: Choose ───────────────────────────────────────────────── */

function ChooseStep({
  cloudConnected,
  onPick,
}: {
  cloudConnected: boolean;
  onPick: (p: PathKind) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t.settings.migrate.chooseIntro}
      </p>

      <PathCard
        icon={Server}
        title={t.settings.migrate.cards.serverTitle}
        body={t.settings.migrate.cards.serverBody}
        meta={t.settings.migrate.cards.serverMeta}
        onClick={() => onPick("server")}
      />

      <PathCard
        icon={Cloud}
        title={t.settings.migrate.cards.cloudTitle}
        body={t.settings.migrate.cards.cloudBody}
        meta={cloudConnected ? t.settings.migrate.cards.cloudMetaConnected : t.settings.migrate.cards.metaRequiresCloud}
        warn={!cloudConnected ? t.settings.migrate.cards.cloudWarn : undefined}
        onClick={() => onPick("cloud")}
      />

      <PathCard
        icon={Network}
        title={t.settings.migrate.cards.tunnelTitle}
        body={t.settings.migrate.cards.tunnelBody}
        meta={cloudConnected ? t.settings.migrate.cards.tunnelMetaConnected : t.settings.migrate.cards.metaRequiresCloud}
        warn={!cloudConnected ? t.settings.migrate.cards.tunnelWarn : undefined}
        onClick={() => onPick("tunnel")}
      />
    </div>
  );
}

function PathCard({
  icon: Icon,
  title,
  body,
  meta,
  warn,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
  meta: string;
  warn?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-start rounded-xl border border-border/50 bg-muted/[0.05] hover:bg-muted/15 hover:border-border p-4 flex items-start gap-4 transition-all"
    >
      <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</p>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground/70 mt-2">
          {meta}
        </p>
        {warn && (
          <p className="text-[11px] text-warning mt-1 flex items-center gap-1">
            <AlertCircle className="size-3" /> {warn}
          </p>
        )}
      </div>
      <ChevronRight className="size-4 text-muted-foreground/70 mt-1 rtl:rotate-180" />
    </button>
  );
}

/* ─── Step 2a: Server form ─────────────────────────────────────────── */

function ServerForm({
  submitting,
  onSubmitStart,
  onSubmitEnd,
  onSuccess,
  showToast,
}: {
  submitting: boolean;
  onSubmitStart: () => void;
  onSubmitEnd: () => void;
  onSuccess: (res: StartServerResult) => void;
  showToast: (msg: string, kind: "success" | "error", topic?: string) => void;
}) {
  const { t } = useI18n();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverId, setServerId] = useState("");
  const [domainKind, setDomainKind] = useState<"custom" | "free">("free");
  const [customHost, setCustomHost] = useState("");
  const [freeSlug, setFreeSlug] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingServers(true);
    systemApi
      .listServers()
      .then((list) => {
        if (!alive) return;
        setServers(list);
        if (list.length === 1) setServerId(list[0].id);
      })
      .catch((err) =>
        showToast(getApiErrorMessage(err, t.settings.migrate.server.toastLoadFailed), "error", t.settings.common.toast.migration),
      )
      .finally(() => {
        if (alive) setLoadingServers(false);
      });
    return () => {
      alive = false;
    };
  }, [showToast, t]);

  const domain: DomainChoice =
    domainKind === "custom"
      ? { kind: "custom", hostname: customHost.trim() }
      : { kind: "free", slug: freeSlug.trim() };

  const canPreflight =
    !!serverId &&
    (domainKind === "custom"
      ? customHost.trim().length > 3
      : /^[a-z0-9-]+$/.test(freeSlug.trim()));

  const runPreflight = async () => {
    if (!canPreflight) return;
    setRunning(true);
    setPreflight(null);
    try {
      const res = await migrationApi.preflight({ serverId, domain });
      setPreflight(res);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.migrate.server.toastPreflightFailed), "error", t.settings.common.toast.migration);
    } finally {
      setRunning(false);
    }
  };

  const handleStart = async () => {
    if (!preflight?.ready) return;
    onSubmitStart();
    try {
      const res = await migrationApi.startServer({ serverId, domain });
      onSuccess(res);
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.migrate.server.toastMigrationFailed), "error", t.settings.common.toast.migration);
    } finally {
      onSubmitEnd();
    }
  };

  return (
    <div className="space-y-5">
      {/* Server picker */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.migrate.server.targetServer}</label>
        {loadingServers ? (
          <div className="rounded-xl border border-border/50 px-3 py-3 text-xs text-muted-foreground">
            {t.settings.migrate.server.loadingServers}
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-border/50 px-3 py-3 text-xs text-muted-foreground">
            {t.settings.migrate.server.noServersPrefix} <span className="font-mono">/system/servers</span>.
          </div>
        ) : (
          <select
            value={serverId}
            onChange={(e) => {
              setServerId(e.target.value);
              setPreflight(null);
            }}
            disabled={submitting}
            className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground"
          >
            <option value="">{t.settings.migrate.server.pickServer}</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || <BlurIp>{s.sshHost}</BlurIp>} ({s.sshUser}@<BlurIp>{s.sshHost}</BlurIp>)
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Domain choice */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.migrate.server.domain}</label>
        <div className="grid grid-cols-2 gap-2">
          <ToggleButton
            selected={domainKind === "free"}
            disabled={submitting}
            onClick={() => {
              setDomainKind("free");
              setPreflight(null);
            }}
          >
            <span className="text-sm font-medium">{t.settings.migrate.server.freeSubdomain}</span>
            <span className="text-[11px] text-muted-foreground">{t.settings.migrate.server.freeSubdomainHint}</span>
          </ToggleButton>
          <ToggleButton
            selected={domainKind === "custom"}
            disabled={submitting}
            onClick={() => {
              setDomainKind("custom");
              setPreflight(null);
            }}
          >
            <span className="text-sm font-medium">{t.settings.migrate.server.customDomain}</span>
            <span className="text-[11px] text-muted-foreground">{t.settings.migrate.server.customDomainHint}</span>
          </ToggleButton>
        </div>
        {domainKind === "free" ? (
          <div className="relative">
            <input
              value={freeSlug}
              onChange={(e) => {
                setFreeSlug(e.target.value.toLowerCase());
                setPreflight(null);
              }}
              placeholder={t.settings.migrate.server.freeSlugPlaceholder}
              disabled={submitting}
              className="w-full ps-3 pe-24 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground font-mono"
            />
            <span className="absolute end-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
              .opsh.io
            </span>
          </div>
        ) : (
          <input
            value={customHost}
            onChange={(e) => {
              setCustomHost(e.target.value.toLowerCase());
              setPreflight(null);
            }}
            placeholder={t.settings.migrate.server.customHostPlaceholder}
            disabled={submitting}
            className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground font-mono"
          />
        )}
      </div>

      {/* Preflight checklist */}
      {preflight && (
        <div className="rounded-xl border border-border/50 p-4 space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {t.settings.migrate.server.preflight}
          </p>
          <CheckRow ok={preflight.checks.ssh.ok} label={t.settings.migrate.server.sshReachable}>
            {preflight.checks.ssh.detail}
          </CheckRow>
          <CheckRow ok={preflight.checks.releaseDist.ok} label={t.settings.migrate.server.releaseAvailable}>
            {preflight.checks.releaseDist.detail}
          </CheckRow>
          <CheckRow ok={preflight.checks.domain.ok} label={t.settings.migrate.server.domainReady}>
            {preflight.checks.domain.detail}
          </CheckRow>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        {!preflight && (
          <button
            type="button"
            onClick={runPreflight}
            disabled={!canPreflight || running || submitting}
            className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 hover:bg-muted text-foreground rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {running && <Loader2 className="size-4 animate-spin" />}
            {t.settings.migrate.server.runPreflight}
          </button>
        )}
        {preflight && (
          <>
            <button
              type="button"
              onClick={runPreflight}
              disabled={running || submitting}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {t.settings.migrate.server.recheck}
            </button>
            <button
              type="button"
              onClick={handleStart}
              disabled={!preflight.ready || submitting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? t.settings.migrate.server.deploying : t.settings.migrate.server.startMigration}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Step 2b: Cloud form ──────────────────────────────────────────── */

function CloudForm({
  cloudConnected,
  submitting,
  onSubmitStart,
  onSubmitEnd,
  onSuccess,
  showToast,
}: {
  cloudConnected: boolean;
  submitting: boolean;
  onSubmitStart: () => void;
  onSubmitEnd: () => void;
  onSuccess: (res: StartCloudResult) => void;
  showToast: (msg: string, kind: "success" | "error", topic?: string) => void;
}) {
  const { t } = useI18n();
  const [allowNonEmptyTarget, setAllowNonEmptyTarget] = useState(false);

  const handleStart = async () => {
    onSubmitStart();
    try {
      const res = await migrationApi.startCloud({ allowNonEmptyTarget });
      onSuccess(res);
    } catch (err: unknown) {
      const apiErr = err as { status?: number; body?: { projectCount?: number } };
      if (apiErr.status === 409 && !allowNonEmptyTarget) {
        showToast(
          interpolate(t.settings.migrate.cloud.toastConflict, { count: String(apiErr.body?.projectCount ?? "some") }),
          "error",
          t.settings.common.toast.migration,
        );
      } else {
        showToast(getApiErrorMessage(err, t.settings.migrate.cloud.toastFailed), "error", t.settings.common.toast.migration);
      }
    } finally {
      onSubmitEnd();
    }
  };

  if (!cloudConnected) {
    return (
      <div className="rounded-xl border border-warning-border bg-warning-bg p-4 space-y-2">
        <div className="flex items-center gap-2 text-warning">
          <AlertCircle className="size-4" />
          <p className="text-sm font-medium">{t.settings.migrate.cloud.connectFirstTitle}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t.settings.migrate.cloud.connectFirstBody}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 p-4 space-y-2">
        <p className="text-sm text-foreground">{t.settings.migrate.cloud.whatHappens}</p>
        <ul className="space-y-1 text-xs text-muted-foreground list-disc list-inside">
          <li>{t.settings.migrate.cloud.bullet1}</li>
          <li>{t.settings.migrate.cloud.bullet2}</li>
          <li>{t.settings.migrate.cloud.bullet3}</li>
          <li>{t.settings.migrate.cloud.bullet4}</li>
        </ul>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={allowNonEmptyTarget}
          onChange={(e) => setAllowNonEmptyTarget(e.target.checked)}
          disabled={submitting}
        />
        <span className="text-sm text-foreground">
          {t.settings.migrate.cloud.proceedNonEmpty}
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handleStart}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? t.settings.migrate.cloud.pushingData : t.settings.migrate.cloud.startMigration}
        </button>
      </div>
    </div>
  );
}

/* ─── Step 2c: Tunnel form ─────────────────────────────────────────── */

function TunnelForm({
  cloudConnected,
  submitting,
  onSubmitStart,
  onSubmitEnd,
  onSuccess,
  showToast,
}: {
  cloudConnected: boolean;
  submitting: boolean;
  onSubmitStart: () => void;
  onSubmitEnd: () => void;
  onSuccess: (res: StartTunnelResult) => void;
  showToast: (msg: string, kind: "success" | "error", topic?: string) => void;
}) {
  const { t } = useI18n();
  const [slug, setSlug] = useState("");

  const handleStart = async () => {
    if (!slug) return;
    onSubmitStart();
    try {
      const res = await migrationApi.startTunnel({ slug: slug.trim() });
      onSuccess(res);
    } catch (err: unknown) {
      const apiErr = err as { status?: number };
      if (apiErr.status === 409) {
        showToast(interpolate(t.settings.migrate.tunnel.toastSlugTaken, { slug }), "error", t.settings.common.toast.migration);
      } else if (apiErr.status === 412) {
        showToast(
          t.settings.migrate.tunnel.toastNeedsCloud,
          "error",
          t.settings.common.toast.migration,
        );
      } else {
        showToast(getApiErrorMessage(err, t.settings.migrate.tunnel.toastFailed), "error", t.settings.common.toast.migration);
      }
    } finally {
      onSubmitEnd();
    }
  };

  if (!cloudConnected) {
    return (
      <div className="rounded-xl border border-warning-border bg-warning-bg p-4 space-y-2">
        <div className="flex items-center gap-2 text-warning">
          <AlertCircle className="size-4" />
          <p className="text-sm font-medium">{t.settings.migrate.tunnel.connectFirstTitle}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t.settings.migrate.tunnel.connectFirstBody}
        </p>
      </div>
    );
  }

  const slugOk = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(slug.trim());

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 p-4 space-y-2">
        <p className="text-sm text-foreground">{t.settings.migrate.tunnel.headsUp}</p>
        <ul className="space-y-1 text-xs text-muted-foreground list-disc list-inside">
          <li>{t.settings.migrate.tunnel.bullet1}</li>
          <li>{t.settings.migrate.tunnel.bullet2}</li>
          <li>{t.settings.migrate.tunnel.bullet3}</li>
        </ul>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.migrate.tunnel.tunnelSlug}</label>
        <div className="relative">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder={t.settings.migrate.tunnel.slugPlaceholder}
            disabled={submitting}
            className="w-full ps-3 pe-32 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground font-mono"
          />
          <span className="absolute end-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
            .preview.oblien.com
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t.settings.migrate.tunnel.slugHint}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handleStart}
          disabled={!slugOk || submitting}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? t.settings.migrate.tunnel.provisioning : t.settings.migrate.tunnel.provisionTunnel}
        </button>
      </div>
    </div>
  );
}

/* ─── Step 3: Result ───────────────────────────────────────────────── */

function ResultStep({
  url,
  detail,
  onDone,
}: {
  url: string;
  detail: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-success-border bg-success-bg p-4">
        <CheckCircle2 className="size-5 text-success shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-foreground">{t.settings.migrate.result.complete}</p>
          <p className="text-xs text-muted-foreground mt-1">{detail}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border/50 px-4 py-3 space-y-1">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t.settings.migrate.result.newLocation}</p>
        <p className="text-sm font-mono text-foreground break-all">{url}</p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 hover:bg-muted text-foreground rounded-xl text-sm font-medium transition-colors"
        >
          <ExternalLink className="size-4" />
          {t.settings.migrate.result.open}
        </a>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90"
        >
          {t.settings.migrate.result.done}
        </button>
      </div>
    </div>
  );
}

/* ─── Tiny shared bits ─────────────────────────────────────────────── */

function CheckRow({
  ok,
  label,
  children,
}: {
  ok: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="size-4 text-success shrink-0 mt-0.5" />
      ) : (
        <AlertCircle className="size-4 text-warning shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function ToggleButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded-xl border transition-all disabled:opacity-50 ${
        selected
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/50 bg-muted/[0.05] hover:bg-muted/15"
      }`}
    >
      {children}
    </button>
  );
}
