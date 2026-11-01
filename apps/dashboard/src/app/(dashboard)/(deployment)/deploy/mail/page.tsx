"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Webmail deploy screen - opinionated picker that hands off to the standard
 * build session UI.
 *
 * Flow:
 *   1. Operator opens /emails → Deploy webmail (carries mail serverId).
 *   2. Picks target host + domain on this page.
 *   3. Submit creates a project + queued deployment + build session and
 *      redirects to /build/[deploymentId], where the regular SSE stream
 *      drives the terminal + stepper UI.
 *
 * No build/start-command knobs - the engine is fully prescriptive for
 * webmail. Operators only choose where and what domain.
 *
 * One extra state: a webmail deployed by a PRE-CATALOG openship can't be
 * redeployed, only replaced. The API refuses it with 409 `LEGACY_WEBMAIL` until
 * the request carries `replaceLegacy`, so this page explains what goes and turns
 * Deploy into Replace - the operator confirms by pressing that, not a dialog.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppDestinationPicker, type AppDestination } from "@/components/deploy/AppDestinationPicker";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import {
  mailApi,
  type MailSetupStatus,
} from "@/lib/api";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/client";
import { mailHostname } from "@repo/core";
import { usePlatform } from "@/context/PlatformContext";
import { canManageMailServers } from "@/lib/mail-availability";
import { CloudMailClient } from "@/app/(dashboard)/emails/_components/cloud-mail-client";

/** The API's code for "this webmail predates the catalog app". */
const LEGACY_WEBMAIL_CODE = "LEGACY_WEBMAIL";

export default function DeployMailPage() {
  const platform = usePlatform();
  if (!canManageMailServers(platform)) return <CloudMailClient />;
  return <DeployMailInner />;
}

function DeployMailInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const tm = t.deploy.mail;
  const mailServerId = searchParams.get("serverId") ?? "";

  const [status, setStatus] = useState<MailSetupStatus | null>(null);
  const [bootReady, setBootReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [domain, setDomain] = useState("");
  const [destination, setDestination] = useState<AppDestination | null>(null);
  const [destinationReady, setDestinationReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitPending = useRef(false);
  // Armed from the mail status (the normal path), or by a 409 LEGACY_WEBMAIL on a
  // stale page - either way the operator sees the notice before the button acts.
  const [replacing, setReplacing] = useState(false);
  const [reconnectProjectId, setReconnectProjectId] = useState("");

  useEffect(() => {
    setBootReady(false);
    setBootError(null);
    setStatus(null);
    setDestination(null);
    setDestinationReady(false);
    setDomain("");
    setReplacing(false);
    setReconnectProjectId("");
    if (!mailServerId) {
      setBootReady(true);
      return;
    }
    let cancelled = false;
    mailApi.getStatus(mailServerId).then((st) => {
      if (cancelled) return;
      if (st) {
        setStatus(st);
        // An existing webmail's own hostname wins: a redeploy (or a replace) that
        // silently defaulted to `mail.<domain>` would MOVE a webmail the operator
        // came here to redeploy in place.
        //
        // `routingUnknown` is that same move by a different route: the API returns no
        // hostname when it could not READ the routing, which is indistinguishable here
        // from having none. So an unknown one prefills nothing and the operator types
        // the address — an empty field asks a question, a guessed one relocates a live
        // webmail without ever asking.
        const existing = st.webmail?.hostname;
        if (existing) setDomain(existing);
        else if (st.webmail?.routingUnknown) setDomain("");
        else if (st.domain) setDomain(mailHostname(st.domain));
        if (st.webmail?.legacy) setReplacing(true);
      }
      setDestination({
        deployTarget: st?.webmail?.workspaceId ? "cloud" : "server",
        serverId: st?.webmail?.serverId ?? mailServerId,
        workspaceId: st?.webmail?.workspaceId ?? undefined,
      });
      setBootReady(true);
    }).catch((error) => {
      if (!cancelled) setBootError(getApiErrorMessage(error, t.chrome.apiDown.title));
    });
    return () => {
      cancelled = true;
    };
  }, [mailServerId, loadAttempt, t.chrome.apiDown.title]);

  const recoveryCandidates = status?.webmailRecoveryCandidates ?? [];
  const recovering = !!reconnectProjectId;
  const canSubmit = useMemo(() => (
    bootReady && destinationReady && !!destination?.serverId &&
    (!recoveryCandidates.length || !!reconnectProjectId) &&
    /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)
  ), [bootReady, destinationReady, destination, domain, recoveryCandidates.length, reconnectProjectId]);

  const mailHostnameFromStatus = status?.domain ? mailHostname(status.domain) : "";
  // When cloud is chosen AND the chosen domain is the mail server's own
  // `mail.<install>` subdomain, the deploy uses the proxy variant: the
  // workload runs on Opshcloud at *.opsh.io, the mail VPS proxies the
  // public hostname over. DNS stays put - operators don't have to touch
  // it. Otherwise both paths follow normal preflight/DNS expectations.
  const isCloudProxyVariant =
    destination?.deployTarget === "cloud" &&
    !!mailHostnameFromStatus &&
    domain.toLowerCase() === mailHostnameFromStatus;
  // The mail server's own hostname, deployed on the mail server itself: it already
  // resolves here and already has a certificate, so there is nothing for the operator
  // to set up. Worth saying, because this used to be refused (#566) and the hint that
  // asks for DNS reads as work that isn't needed.
  const isMailHostOnMailServer =
    destination?.serverId === mailServerId &&
    !!mailHostnameFromStatus &&
    domain.toLowerCase() === mailHostnameFromStatus;

  const startDeploy = async () => {
    if (!canSubmit || !destination?.serverId || submitPending.current) return;
    submitPending.current = true;
    setSubmitting(true);
    try {
      const target =
        destination.deployTarget === "cloud"
          ? ({ kind: "cloud", serverId: destination.serverId } as const)
          : ({ kind: "self", serverId: destination.serverId } as const);
      const { deploymentId } = await mailApi.webmail.deployAsProject({
        mailServerId,
        hostname: domain.toLowerCase(),
        target,
        // Only ever true once the notice below has been on screen.
        replaceLegacy: replacing,
        ...(reconnectProjectId ? { reconnectProjectId } : {}),
      });
      router.push(`/build/${deploymentId}`);
    } catch (err) {
      submitPending.current = false;
      // The status this page loaded predates the legacy webmail it's about to
      // deploy over. Show what a replace costs and let them press again - never
      // retry a destructive action for them.
      if (getApiErrorCode(err) === LEGACY_WEBMAIL_CODE && !replacing) {
        setReplacing(true);
        toast.showToast(tm.legacyBody, "error", tm.legacyTitle);
        setSubmitting(false);
        return;
      }
      if (["WEBMAIL_RECONNECT_REQUIRED", "WEBMAIL_LINK_CHANGED"].includes(getApiErrorCode(err) ?? "")) {
        setLoadAttempt((attempt) => attempt + 1);
      }
      toast.showToast(
        getApiErrorMessage(err, tm.deployFailed),
        "error",
        tm.deployFailedTitle,
      );
      setSubmitting(false);
    }
  };

  if (!mailServerId) {
    return (
      <PageContainer>
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
          <p className="text-sm text-foreground font-medium">{tm.missingServerTitle}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {tm.missingServerBody}
          </p>
          <Link
            href="/emails"
            className="mt-3 text-sm font-medium text-primary hover:underline inline-block"
          >
            {tm.backToMail}
          </Link>
        </div>
      </PageContainer>
    );
  }

  const domainPlaceholder = status?.domain
    ? mailHostname(status.domain)
    : "mail.example.com";

  return (
    <PageContainer>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {tm.title}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tm.subtitle}
          </p>
        </div>
        <Link
          href="/emails"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
        >
          <UiIcon name="arrow-left" className="size-3.5 rtl:rotate-180" /> {tm.backToMail}
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-6">
        <div className="space-y-6">
          {replacing && (
            <div className="rounded-xl border border-warning-border bg-warning-bg p-4 flex gap-3">
              <UiIcon name="warning" className="size-4 text-warning shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{tm.legacyTitle}</p>
                <p className="text-sm text-muted-foreground mt-1">{tm.legacyBody}</p>
                <p className="text-sm text-muted-foreground mt-1">{tm.legacyKept}</p>
              </div>
            </div>
          )}

          {bootReady && recoveryCandidates.length > 0 && (
            <fieldset className="rounded-2xl bg-card p-5 space-y-3" disabled={submitting}>
              <legend className="sr-only">{tm.reconnectTitle}</legend>
              <div className="flex gap-3">
                <UiIcon name="warning" className="size-4 text-warning shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{tm.reconnectTitle}</p>
                  <p className="text-sm text-muted-foreground mt-1">{tm.reconnectBody}</p>
                </div>
              </div>
              {recoveryCandidates.map(candidate => (
                <label key={candidate.projectId} className="flex items-center gap-3 rounded-xl bg-background p-3 cursor-pointer">
                  <input type="radio" name="webmail-recovery" value={candidate.projectId}
                    checked={reconnectProjectId === candidate.projectId}
                    onChange={() => {
                      setReconnectProjectId(candidate.projectId);
                      setDomain(candidate.hostname);
                      setDestination({ deployTarget: "server", serverId: candidate.serverId });
                    }}
                    className="accent-primary size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground truncate">{candidate.name}</span>
                    <span className="block text-xs text-muted-foreground truncate">{candidate.hostname}</span>
                  </span>
                </label>
              ))}
              <p className="text-xs text-muted-foreground">{recovering ? tm.reconnectPlacement : tm.reconnectChoose}</p>
            </fieldset>
          )}

          <Section
            title={tm.deployToTitle}
            hint={tm.deployToHint}
          >
            {bootError ? (
              <div role="alert" className="rounded-2xl bg-card p-5 space-y-3">
                <p className="text-sm text-destructive">{bootError}</p>
                <Button variant="secondary" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                  {t.chrome.apiDown.retry}
                </Button>
              </div>
            ) : !bootReady ? (
              <div className="rounded-2xl bg-card px-4 py-6 text-sm text-muted-foreground flex items-center gap-2">
                <UiIcon name="spinner" className="size-4 animate-spin" /> {tm.loadingTargets}
              </div>
            ) : (
              <AppDestinationPicker
                value={destination}
                onChange={setDestination}
                onReadyChange={setDestinationReady}
                disabled={submitting || recovering}
              />
            )}
          </Section>

          <Section
            title={tm.domainTitle}
            hint={
              isCloudProxyVariant
                ? tm.domainHintProxy
                : isMailHostOnMailServer
                  ? tm.domainHintMailHost
                  : destination?.deployTarget === "cloud"
                    ? tm.domainHintCloud
                    : tm.domainHintDefault
            }
          >
            <Input
              variant="filled"
              aria-label={tm.domainTitle}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={domainPlaceholder}
              spellCheck={false}
              autoComplete="off"
              disabled={!bootReady || submitting || recovering}
            />
          </Section>
        </div>

        <aside className="lg:sticky lg:top-6 h-fit space-y-4">
          <div className="bg-card rounded-2xl p-5 space-y-3">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {tm.summary}
            </p>
            <SummaryRow label={tm.summaryDomain} value={domain || "-"} />
            {mailHostnameFromStatus && (
              <SummaryRow label={tm.summaryMailServer} value={mailHostnameFromStatus} />
            )}
          </div>
          <Button
            type="button"
            onClick={startDeploy}
            disabled={!canSubmit || submitting}
            className="h-11 w-full"
          >
            {submitting ? (
              <>
                <UiIcon name="spinner" className="size-4 animate-spin" /> {tm.starting}
              </>
            ) : recovering ? (
              <>
                <UiIcon name="refresh" className="size-4" />
                {tm.reconnectButton}
              </>
            ) : replacing ? (
              <>
                <UiIcon name="refresh" className="size-4" />
                {tm.replaceButton}
              </>
            ) : (
              <>
                {tm.deployButton}
                <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
              </>
            )}
          </Button>
        </aside>
      </div>
    </PageContainer>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground truncate">{value}</span>
    </div>
  );
}
