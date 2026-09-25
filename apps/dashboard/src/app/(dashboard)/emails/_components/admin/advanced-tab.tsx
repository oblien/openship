"use client";

/**
 * Advanced tab - power-user surface.
 *
 * Layout (top → bottom):
 *   1. Protocol settings - the host/port/encryption pairs for inbound
 *      (IMAP) and outbound (SMTP). Useful when wiring a client manually
 *      but noisy on the Overview, so it lives here.
 *   2. Mail-stack tools - bulk recovery actions (restart all daemons).
 *      Less destructive than the danger zone - these touch only the
 *      running stack, never the on-disk state. Per-daemon controls live
 *      on the Health tab (logs + 3-dot menu on each daemon row).
 *   3. Danger zone      - re-run wizard, reset on-server state. Tucked
 *      away so the operator isn't one mis-click from a destructive
 *      action while just reading credentials.
 *   4. Install metadata - server ID, primary domain, install timestamps.
 */

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Inbox,
  Lock,
  Loader2,
  RotateCw,
  Send,
  Settings2,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import {
  mailApi,
  mailAdminApi,
  getApiErrorMessage,
  type BulkRestartResult,
  type MailCredentials,
  type MailSetupStatus,
} from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { FormModalContent } from "./_shared/form-modal-content";

interface AdvancedTabProps {
  status: MailSetupStatus;
  serverId: string;
  onChanged: () => void;
  /** Called after the server is removed from the mail registry (DB-only). */
  onForgotten: () => void;
}

export function AdvancedTab({ status, serverId, onChanged, onForgotten }: AdvancedTabProps) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);

  const openReset = () => {
    const id = showModal({
      maxWidth: "480px",
      showCloseButton: false,
      customContent: (
        <FormModalContent
          title={t.emailsAdmin.advanced.resetTitle}
          description={t.emailsAdmin.advanced.resetDesc}
          submitLabel={t.emailsAdmin.advanced.resetSubmit}
          submittingLabel={t.emailsAdmin.advanced.resetSubmitting}
          submitVariant="danger"
          onSubmit={async () => {
            setResetError(null);
            setResetting(true);
            try {
              await mailApi.resetSetup(serverId);
              hideModal(id);
              onChanged();
            } catch (err) {
              setResetError(getApiErrorMessage(err, t.emailsAdmin.advanced.resetFailed));
              throw err;
            } finally {
              setResetting(false);
            }
          }}
          onCancel={() => hideModal(id)}
        >
          <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning leading-relaxed">
            {t.emailsAdmin.advanced.resetBox}
          </div>
        </FormModalContent>
      ),
    });
  };

  const openForget = () => {
    const id = showModal({
      maxWidth: "480px",
      showCloseButton: false,
      customContent: (
        <FormModalContent
          title={t.emailsAdmin.advanced.forgetTitle}
          description={t.emailsAdmin.advanced.forgetDesc}
          submitLabel={t.emailsAdmin.advanced.forgetSubmit}
          submittingLabel={t.emailsAdmin.advanced.forgetSubmitting}
          submitVariant="danger"
          onSubmit={async () => {
            setForgetError(null);
            setForgetting(true);
            try {
              await mailApi.forget(serverId);
              hideModal(id);
              onForgotten();
            } catch (err) {
              setForgetError(getApiErrorMessage(err, t.emailsAdmin.advanced.forgetFailed));
              throw err;
            } finally {
              setForgetting(false);
            }
          }}
          onCancel={() => hideModal(id)}
        >
          <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground leading-relaxed">
            {t.emailsAdmin.advanced.forgetBox}
          </div>
        </FormModalContent>
      ),
    });
  };

  return (
    <div className="space-y-8">
      {/* Protocol settings */}
      {status.credentials && (
        <section className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <Settings2
                className="size-4 text-muted-foreground"
                strokeWidth={2.25}
              />
              <h2 className="text-lg font-semibold text-foreground">
                {t.emailsAdmin.advanced.protocolTitle}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              {t.emailsAdmin.advanced.protocolDesc}
            </p>
          </div>
          <ProtocolCard credentials={status.credentials} />
        </section>
      )}

      {/* Mail-stack recovery tools */}
      <MailStackToolsSection serverId={serverId} />

      {/* Danger zone */}
      <section className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle
              className="size-4 text-warning"
              strokeWidth={2.25}
            />
            <h2 className="text-lg font-semibold text-foreground">{t.emailsAdmin.advanced.dangerTitle}</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            {t.emailsAdmin.advanced.dangerDesc}
          </p>
        </div>

        {/* Re-run setup */}
        <DangerCard
          icon={RotateCw}
          title={t.emailsAdmin.advanced.rerunTitle}
          description={t.emailsAdmin.advanced.rerunDesc}
          action={
            <Link
              href={`/emails?serverId=${encodeURIComponent(serverId)}&force=wizard`}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors"
            >
              <RotateCw className="size-3.5" />
              {t.emailsAdmin.advanced.openWizard}
            </Link>
          }
        />

        {/* Reset on-server state */}
        <DangerCard
          icon={Trash2}
          title={t.emailsAdmin.advanced.resetCardTitle}
          description={t.emailsAdmin.advanced.resetCardDesc}
          action={
            <button
              onClick={openReset}
              disabled={resetting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-danger-solid text-white hover:bg-danger-solid/90 transition-colors disabled:opacity-50"
            >
              {resetting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {t.emailsAdmin.advanced.resetStateBtn}
            </button>
          }
          error={resetError}
        />

        {/* Remove from mail list (DB-only) */}
        <DangerCard
          icon={Unplug}
          title={t.emailsAdmin.advanced.removeTitle}
          description={t.emailsAdmin.advanced.removeDesc}
          action={
            <button
              onClick={openForget}
              disabled={forgetting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-danger-solid text-white hover:bg-danger-solid/90 transition-colors disabled:opacity-50"
            >
              {forgetting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              {t.emailsAdmin.advanced.remove}
            </button>
          }
          error={forgetError}
        />
      </section>

      {/* Install metadata */}
      <section>
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <div className="px-5 py-4 border-b border-border/50">
            <h3 className="text-[14px] font-semibold text-foreground">
              {t.emailsAdmin.advanced.metaTitle}
            </h3>
          </div>
          <dl className="divide-y divide-border/40">
            <MetaRow label={t.emailsAdmin.advanced.metaServerId} value={serverId} mono />
            <MetaRow label={t.emailsAdmin.advanced.metaPrimaryDomain} value={status.domain ?? "-"} />
            {status.startedAt && (
              <MetaRow
                label={t.emailsAdmin.advanced.metaStartedAt}
                value={new Date(status.startedAt).toLocaleString()}
              />
            )}
            {status.finishedAt && (
              <MetaRow
                label={t.emailsAdmin.advanced.metaFinishedAt}
                value={new Date(status.finishedAt).toLocaleString()}
              />
            )}
          </dl>
        </div>
      </section>
    </div>
  );
}

// ─── Protocol settings card ──────────────────────────────────────────────────

function ProtocolCard({ credentials }: { credentials: MailCredentials }) {
  const { t } = useI18n();
  const note = t.emailsAdmin.advanced.protocolNote;
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProtocolBlock
          icon={Inbox}
          label={t.emailsAdmin.advanced.incoming}
          host={credentials.imapHost}
          port={credentials.imapPort}
          encryption="SSL/TLS"
        />
        <ProtocolBlock
          icon={Send}
          label={t.emailsAdmin.advanced.outgoing}
          host={credentials.smtpHost}
          port={credentials.smtpPort}
          encryption="STARTTLS"
        />
      </div>
      <div className="mt-4 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
        <p className="text-xs text-foreground/90 leading-relaxed">
          <Lock className="inline-block size-3 me-1 -mt-0.5 text-muted-foreground" />
          {note.p1}<strong>{note.emailAddress}</strong>
          {note.p2}
          <code className="font-mono text-[11.5px] px-1 py-0.5 rounded bg-card border border-border/40">
            {credentials.username}
          </code>
          {note.p3}<em>{note.credPath}</em>{note.p4}
        </p>
      </div>
    </div>
  );
}

function ProtocolBlock({
  icon: Icon,
  label,
  host,
  port,
  encryption,
}: {
  icon: typeof Inbox;
  label: string;
  host: string;
  port: number;
  encryption: string;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
      <div className="flex items-center gap-2 mb-2.5">
        <Icon className="size-3.5 text-muted-foreground" strokeWidth={2} />
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </p>
      </div>
      <dl className="space-y-1.5 text-[13px]">
        <div className="flex items-center gap-3">
          <dt className="w-16 text-xs text-muted-foreground">{t.emailsAdmin.advanced.host}</dt>
          <dd className="font-mono text-foreground truncate">{host}</dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="w-16 text-xs text-muted-foreground">{t.emailsAdmin.advanced.port}</dt>
          <dd className="font-mono text-foreground">{port}</dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="w-16 text-xs text-muted-foreground">{t.emailsAdmin.advanced.security}</dt>
          <dd className="font-mono text-foreground">{encryption}</dd>
        </div>
      </dl>
    </div>
  );
}

function DangerCard({
  icon: Icon,
  title,
  description,
  action,
  error,
}: {
  icon: typeof RotateCw;
  title: string;
  description: string;
  action: React.ReactNode;
  error?: string | null;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-warning-bg flex items-center justify-center shrink-0">
          <Icon className="size-5 text-warning" strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            {description}
          </p>
          {error && (
            <p className="mt-2 text-xs text-danger">{error}</p>
          )}
        </div>
        <div className="shrink-0">{action}</div>
      </div>
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <dt className="w-32 text-xs font-medium text-muted-foreground shrink-0">
        {label}
      </dt>
      <dd
        className={`text-[13px] text-foreground truncate ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

// ─── Mail-stack tools (bulk restart) ─────────────────────────────────────────

/**
 * Common "the box went weird after a deploy" recovery. Restarts every
 * mail-stack unit in one round-trip. Less invasive than the danger zone:
 * it does not touch state, mailboxes, or DNS - it just cycles the running
 * daemons. Reports per-unit success in a toast.
 */
function MailStackToolsSection({ serverId }: { serverId: string }) {
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const a = t.emailsAdmin.advanced;
  const [restarting, setRestarting] = useState(false);

  const runRestart = async () => {
    setRestarting(true);
    try {
      const r: BulkRestartResult = await mailAdminApi.components.restartAll(
        serverId,
      );
      const failures = r.results.filter((x) => !x.ok);
      if (failures.length === 0) {
        showToast(
          interpolate(a.restartedToast, { count: String(r.results.length) }),
          "success",
          a.restartedTitle,
        );
      } else {
        showToast(
          interpolate(a.partialToast, {
            failed: String(failures.length),
            total: String(r.results.length),
            units: failures.map((f) => f.unit).join(", "),
          }),
          "error",
          a.partialTitle,
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : a.restartFailed,
        "error",
        a.restartFailedTitle,
      );
    } finally {
      setRestarting(false);
    }
  };

  const openConfirm = () => {
    const id = showModal({
      maxWidth: "480px",
      showCloseButton: false,
      customContent: (
        <FormModalContent
          title={a.restartConfirmTitle}
          description={a.restartConfirmDesc}
          submitLabel={a.restartStack}
          submittingLabel={a.restartSubmitting}
          submitVariant="primary"
          onSubmit={async () => {
            await runRestart();
            hideModal(id);
          }}
          onCancel={() => hideModal(id)}
        >
          <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground leading-relaxed">
            {a.restartBox}
          </div>
        </FormModalContent>
      ),
    });
  };

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" strokeWidth={2.25} />
          <h2 className="text-lg font-semibold text-foreground">
            {a.toolsTitle}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          {a.toolsDesc}
        </p>
      </div>

      <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
        <div className="flex items-start gap-4 border-b border-border/40 pb-4">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
            <RotateCw
              className="size-5 text-foreground/80"
              strokeWidth={1.75}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-foreground">
              {a.restartCardTitle}
            </h4>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              {a.restartCardDesc}
            </p>
          </div>
          <button
            onClick={openConfirm}
            disabled={restarting}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-50 shrink-0"
          >
            {restarting ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
            ) : (
              <RotateCw className="size-3.5" strokeWidth={2.25} />
            )}
            {a.restartStack}
          </button>
        </div>

        <div className="flex items-start gap-4 pt-1">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
            <Wrench className="size-5 text-foreground/80" strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-foreground">
              Migrate Host Mail to Docker Container
            </h4>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              Convert a legacy host-native (bare-metal systemd) mail installation to a containerized Docker engine with Postgres sidecar without losing accounts or mail.
            </p>
          </div>
          <button
            onClick={async () => {
              setRestarting(true);
              try {
                const res = await mailAdminApi.components.migrateToContainer(serverId);
                showToast(res.message, res.migrated ? "success" : "error");
              } catch (err) {
                showToast(err instanceof Error ? err.message : "Migration failed", "error");
              } finally {
                setRestarting(false);
              }
            }}
            disabled={restarting}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
          >
            {restarting ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
            ) : (
              <Wrench className="size-3.5" strokeWidth={2.25} />
            )}
            Migrate Engine
          </button>
        </div>
      </div>
    </section>
  );
}
