"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { MailCertificateHealth, MailCertificateStatus } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { mailAdminApi, getApiErrorMessage } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Switch } from "@/components/ui/Switch";
import { SectionCard } from "./_shared/section-card";
import { StatusPill, type PillTone } from "./_shared/status-pill";

const TONES: Record<MailCertificateHealth["status"], PillTone> = {
  ok: "success",
  warn: "warning",
  fail: "danger",
  unknown: "neutral",
};
const button =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50";

function CertificateDetails({ health }: { health: MailCertificateHealth | null }) {
  const { t } = useI18n();
  const c = t.emailsAdmin.certificate;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusPill tone={health ? TONES[health.status] : "neutral"}>
          {health ? c.status[health.status] : c.notChecked}
        </StatusPill>
        {health?.certificate && (
          <span className="text-sm text-muted-foreground">
            {interpolate(c.expires, {
              date: new Date(health.certificate.expiresAt).toLocaleDateString(),
            })}
          </span>
        )}
      </div>
      {health?.detail && health.status !== "ok" && (
        <p
          className={`text-sm ${health.status === "fail" ? "text-danger" : "text-muted-foreground"}`}
        >
          {health.detail}
        </p>
      )}
      {!!health?.endpoints.length && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {health.endpoints.map((endpoint) => {
            const ready = endpoint.trusted && endpoint.certificate?.fingerprint === health.certificate?.fingerprint;
            return <span key={endpoint.port} className="inline-flex items-center gap-1.5">
              <Icon
                name={ready ? "check-circle" : "warning"}
                className={`size-3.5 ${ready ? "text-success" : "text-warning"}`}
              />
              {endpoint.protocol === "imap" ? "IMAP" : "SMTP"} {endpoint.port}
            </span>;
          })}
        </div>
      )}
      {health && (
        <p className="text-xs text-muted-foreground">
          {interpolate(c.checked, { time: new Date(health.checkedAt).toLocaleString() })}
        </p>
      )}
    </div>
  );
}

export function CertificateHealthCard({
  health,
  serverId,
}: {
  health: MailCertificateHealth | null;
  serverId: string;
}) {
  const { t } = useI18n();
  return (
    <SectionCard
      title={t.emailsAdmin.certificate.title}
      icon="lock"
      action={
        <Link
          className="text-sm text-muted-foreground hover:text-foreground"
          href={`/emails?serverId=${encodeURIComponent(serverId)}&tab=advanced`}
        >
          {t.emailsAdmin.certificate.manage}
        </Link>
      }
    >
      <CertificateDetails health={health} />
    </SectionCard>
  );
}

export function MailCertificateCard({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const c = t.emailsAdmin.certificate;
  const [data, setData] = useState<MailCertificateStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "renew" | "save" | null>("check");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setBusy("check");
    setError(null);
    mailAdminApi.certificate
      .get(serverId)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err) => {
        if (active) setError(getApiErrorMessage(err, c.failed));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [serverId, c.failed]);

  const run = async (action: "check" | "renew" | "save", enabled?: boolean) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const result =
        action === "save"
          ? await mailAdminApi.certificate.update(serverId, enabled!)
          : await mailAdminApi.certificate[action](serverId);
      setData(result);
    } catch (err) {
      setError(getApiErrorMessage(err, c.failed));
      // Renewal can write a new certificate before a later reload fails. Keep the
      // displayed observation current while preserving the operation's error.
      if (action === "renew") {
        const result = await mailAdminApi.certificate.get(serverId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/emails/_components/admin/certificate-card"); return null; });
        if (result) setData(result);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard title={c.title} description={data?.hostname} icon="lock">
      <div className="space-y-4" aria-busy={!!busy}>
        {!data && busy ? (
          <p className="text-sm text-muted-foreground">{c.checking}</p>
        ) : (
          <CertificateDetails health={data?.health ?? null} />
        )}
        {(error || data?.lastRenewalError) && (
          <p role="alert" className="text-sm text-danger break-words">
            {error || data?.lastRenewalError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={!!busy}
            onClick={() => void run("check")}
          >
            <Icon
              name={busy === "check" ? "spinner" : "refresh"}
              className={`size-3.5 ${busy === "check" ? "animate-spin" : ""}`}
            />
            {busy === "check" ? c.checking : c.check}
          </button>
          <button
            type="button"
            className={button}
            disabled={!!busy || !data}
            onClick={() => void run("renew")}
          >
            <Icon
              name={busy === "renew" ? "spinner" : "lock"}
              className={`size-3.5 ${busy === "renew" ? "animate-spin" : ""}`}
            />
            {busy === "renew" ? c.renewing : c.renew}
          </button>
        </div>
        {data && (
          <div className="border-t border-border/50 pt-4 space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{c.autoRenew}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{c.autoRenewHint}</p>
              </div>
              <Switch
                checked={data.autoRenew}
                disabled={!!busy}
                onChange={(enabled) => void run("save", enabled)}
                ariaLabel={c.autoRenew}
              />
            </div>
            {data.autoRenew && !data.renewalJobEnabled && (
              <p className="text-sm text-warning">
                {c.jobDisabled}{" "}
                <Link href="/jobs/ssl%3Arenew" className="underline underline-offset-2">
                  {c.manageJob}
                </Link>
              </p>
            )}
            {data.desktop && data.autoRenew && (
              <p className="text-xs text-muted-foreground">{c.desktopHint}</p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
