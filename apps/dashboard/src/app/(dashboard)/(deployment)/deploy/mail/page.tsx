"use client";

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

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Inbox,
  Loader2,
  RefreshCw,
  Server,
  TriangleAlert,
} from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { OptionCard } from "../[slug]/components/DeployTargetStep";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import {
  mailApi,
  type MailSetupStatus,
  type WebmailTargetOption,
} from "@/lib/api";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/client";

/** The API's code for "this webmail predates the catalog app". */
const LEGACY_WEBMAIL_CODE = "LEGACY_WEBMAIL";

export default function DeployMailPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const tm = t.deploy.mail;
  const mailServerId = searchParams.get("serverId") ?? "";

  const [status, setStatus] = useState<MailSetupStatus | null>(null);
  const [bootReady, setBootReady] = useState(false);

  const [domain, setDomain] = useState("");
  // selectedKey is `${kind}:${serverId}` so we can distinguish "opshcloud"
  // (serverId is "") from a self-hosted server even when the latter is empty
  // for some reason - keys never collide across kinds.
  const [selectedKey, setSelectedKey] = useState("");
  const [targets, setTargets] = useState<WebmailTargetOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Armed from the mail status (the normal path), or by a 409 LEGACY_WEBMAIL on a
  // stale page - either way the operator sees the notice before the button acts.
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    if (!mailServerId) {
      setBootReady(true);
      return;
    }
    let cancelled = false;
    Promise.all([
      mailApi.getStatus(mailServerId).catch(() => null),
      mailApi.webmail.listTargets(mailServerId).catch(() => ({ options: [] })),
    ]).then(([st, tg]) => {
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
        else if (st.domain) setDomain(`mail.${st.domain}`);
        if (st.webmail?.legacy) setReplacing(true);
      }
      setTargets(tg.options);
      const first = tg.options.find((o) => !o.disabled);
      if (first) setSelectedKey(`${first.kind}:${first.serverId}`);
      setBootReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [mailServerId]);

  const selectedTarget = targets.find(
    (t) => `${t.kind}:${t.serverId}` === selectedKey,
  );

  const canSubmit = useMemo(() => {
    if (!domain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
      return false;
    if (!selectedTarget) return false;
    if (selectedTarget.disabled) return false;
    if (selectedTarget.kind !== "opshcloud" && !selectedTarget.serverId)
      return false;
    return true;
  }, [domain, selectedTarget]);

  const mailHostnameFromStatus = status?.domain ? `mail.${status.domain}` : "";
  // When cloud is chosen AND the chosen domain is the mail server's own
  // `mail.<install>` subdomain, the deploy uses the proxy variant: the
  // workload runs on Opshcloud at *.opsh.io, the mail VPS proxies the
  // public hostname over. DNS stays put - operators don't have to touch
  // it. Otherwise both paths follow normal preflight/DNS expectations.
  const isCloudProxyVariant =
    selectedTarget?.kind === "opshcloud" &&
    !!mailHostnameFromStatus &&
    domain.toLowerCase() === mailHostnameFromStatus;

  const startDeploy = async () => {
    if (!canSubmit || !selectedTarget) return;
    setSubmitting(true);
    try {
      const target =
        selectedTarget.kind === "opshcloud"
          ? ({ kind: "cloud" } as const)
          : ({ kind: "self", serverId: selectedTarget.serverId } as const);
      const { deploymentId } = await mailApi.webmail.deployAsProject({
        mailServerId,
        hostname: domain.toLowerCase(),
        target,
        // Only ever true once the notice below has been on screen.
        replaceLegacy: replacing,
      });
      router.push(`/build/${deploymentId}`);
    } catch (err) {
      // The status this page loaded predates the legacy webmail it's about to
      // deploy over. Show what a replace costs and let them press again - never
      // retry a destructive action for them.
      if (getApiErrorCode(err) === LEGACY_WEBMAIL_CODE && !replacing) {
        setReplacing(true);
        toast.showToast(tm.legacyBody, "error", tm.legacyTitle);
        setSubmitting(false);
        return;
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

  // `selectedTarget` is computed above (right after the `useEffect` that
  // loads targets) - it drives both the proxy-variant detection and the
  // submit-button disabled state, so it lives there rather than here.
  const domainPlaceholder = status?.domain
    ? `mail.${status.domain}`
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
          <ArrowLeft className="size-3.5 rtl:rotate-180" /> {tm.backToMail}
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-6">
        <div className="space-y-6">
          {replacing && (
            <div className="rounded-xl border border-warning-border bg-warning-bg p-4 flex gap-3">
              <TriangleAlert className="size-4 text-warning shrink-0 mt-0.5" strokeWidth={2} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{tm.legacyTitle}</p>
                <p className="text-sm text-muted-foreground mt-1">{tm.legacyBody}</p>
                <p className="text-sm text-muted-foreground mt-1">{tm.legacyKept}</p>
              </div>
            </div>
          )}

          <Section
            title={tm.deployToTitle}
            hint={tm.deployToHint}
          >
            {!bootReady ? (
              <div className="rounded-xl border border-border/50 bg-card px-4 py-6 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> {tm.loadingTargets}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {targets.map((t) => {
                  const Icon =
                    t.kind === "mail"
                      ? Inbox
                      : t.kind === "server"
                        ? Server
                        : Globe;
                  const key = `${t.kind}:${t.serverId}`;
                  return (
                    <OptionCard
                      key={`${t.kind}-${t.serverId || t.label}`}
                      value={key}
                      selected={selectedKey === key}
                      onSelect={() => {
                        if (!t.disabled) setSelectedKey(key);
                      }}
                      icon={<Icon className="size-5" />}
                      label={t.label}
                      description={
                        t.description ||
                        (t.disabled ? t.disabledReason || tm.notAvailable : "")
                      }
                      className="h-full"
                    />
                  );
                })}
              </div>
            )}
          </Section>

          <Section
            title={tm.domainTitle}
            hint={
              isCloudProxyVariant
                ? tm.domainHintProxy
                : selectedTarget?.kind === "opshcloud"
                  ? tm.domainHintCloud
                  : tm.domainHintDefault
            }
          >
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={domainPlaceholder}
              className="w-full px-4 py-3 bg-card border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              spellCheck={false}
              autoComplete="off"
              disabled={submitting}
            />
          </Section>
        </div>

        <aside className="lg:sticky lg:top-6 h-fit space-y-4">
          <div className="bg-card rounded-xl border border-border/50 p-4 space-y-3">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {tm.summary}
            </p>
            <SummaryRow label={tm.summaryTarget} value={selectedTarget?.label ?? "-"} />
            <SummaryRow label={tm.summaryDomain} value={domain || "-"} />
            {mailHostnameFromStatus && (
              <SummaryRow label={tm.summaryMailServer} value={mailHostnameFromStatus} />
            )}
          </div>
          <button
            type="button"
            onClick={startDeploy}
            disabled={!canSubmit || submitting}
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground text-sm font-semibold rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> {tm.starting}
              </>
            ) : replacing ? (
              <>
                <RefreshCw className="size-4" />
                {tm.replaceButton}
              </>
            ) : (
              <>
                {tm.deployButton}
                <ArrowRight className="size-4 rtl:rotate-180" />
              </>
            )}
          </button>
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
