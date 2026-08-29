"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Server, Plug } from "lucide-react";
import { deployApi, mailApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppDestinationPicker, type AppDestination } from "@/components/deploy/AppDestinationPicker";
import { MAIL_PROVIDERS, mailProvider, type MailProviderId } from "@/lib/mail-providers";
import { mailTabHref } from "@/lib/sidebar-nav";
import {
  CleanDeployProgressCard,
  labelForStatus,
  firstPublicHost,
} from "@/components/deploy/CleanDeployProgress";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { OptionCard } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import { useToast } from "@/context/ToastContext";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { mailHostname } from "@repo/core";

/**
 * Mail provider wizard — the app-catalog entry point for Openship Mail, and the
 * ONLY one: the webmail app is `unlisted` in the catalog precisely so this chooser
 * is where both branches start. A provider chooser that WRAPS the existing
 * machinery, no duplication:
 *
 *   • Self-host        → the mail-engine provisioning flow at /emails (SMTP/IMAP +
 *                        mailboxes + webmail on one server).
 *   • Connect existing → install just the webmail app pointed at an external
 *                        IMAP/SMTP backend (Amazon SES for send, Gmail/Fastmail,
 *                        or any custom host) via POST /mail/webmail/deploy-external.
 *
 * The destination ("where to install") reuses the deploy wizard's target picker.
 */

type Phase = "choose" | "connect" | "installing" | "done" | "error";

export default function MailWizardPage() {
  const router = useRouter();
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  const m = w.mail;
  const { showToast } = useToast();
  const { connected: cloudConnected, requireCloud } = useCloud();
  const { baseDomain } = usePlatform();

  const [phase, setPhase] = useState<Phase>("choose");
  const [preset, setPreset] = useState<MailProviderId>("custom");
  const [hostname, setHostname] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [destination, setDestination] = useState<AppDestination | null>(null);

  const [busy, setBusy] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  /**
   * This instance's own mail server, when one is installed.
   *
   * Every send-only relay in the catalog (SES, SendGrid, Mailgun, Postmark,
   * Resend, Oracle) has `imapHost: ""` — correctly, they hold no mailboxes. But
   * the IMAP host is REQUIRED, so picking one used to leave a blank required
   * field and the operator had to already know to type `mail.<domain>`. If we run
   * a mail server, that IS the answer: `mail.<domain>:993`, the same coordinates
   * the mail-server-backed webmail deploy pins server-side
   * (`webmail-install.service.ts` → `WEBMAIL_SETTING_KEYS.imapHost`).
   */
  const [mailServers, setMailServers] = useState<
    { id: string; domain: string | null; completed: boolean; active: boolean }[]
  >([]);
  const ourMailServer = useMemo(
    () => mailServers.find((s) => s.completed && s.domain) ?? null,
    [mailServers],
  );
  const ourMailHost = ourMailServer?.domain ? mailHostname(ourMailServer.domain) : null;

  useEffect(() => {
    void (async () => {
      try {
        const res = await mailApi.listMailServers();
        setMailServers(res?.servers ?? []);
      } catch {
        // Wizard still works without it — the operator types the IMAP host.
      }
    })();
  }, []);

  const applyPreset = (id: MailProviderId) => {
    setPreset(id);
    const p = mailProvider(id);
    setImapHost(p.sendOnly ? ourMailHost ?? "" : p.imapHost);
    setImapPort(p.imapPort);
    setSmtpHost(p.smtpHost);
    setSmtpPort(p.smtpPort);
  };

  const presetSpec = mailProvider(preset);
  const usingOurImap = !!ourMailHost && presetSpec.sendOnly && imapHost === ourMailHost;

  // The server list can land after a preset was picked. Fill the host the moment
  // we know it rather than leaving the blank field the operator already saw.
  useEffect(() => {
    if (!ourMailHost || !mailProvider(preset).sendOnly) return;
    setImapHost((cur) => (cur.trim() === "" ? ourMailHost : cur));
  }, [ourMailHost, preset]);

  // ── Clean progress poll (status only, never raw logs) ──────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (phase !== "installing" || !deploymentId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await deployApi.getBuildStatus(deploymentId);
        const s = res?.data ?? res ?? {};
        const status: string = s.deploymentStatus ?? s.status ?? "queued";
        setProgress(typeof s.progress === "number" ? s.progress : 0);
        setPhaseLabel(labelForStatus(status, w));
        // `no_changes` settles as a success: nothing shipped because the stack was
        // already up to date, so the install is done.
        if (status === "ready" || status === "no_changes") {
          setLiveUrl(firstPublicHost(s?.config?.publicEndpoints, baseDomain));
          setPhase("done");
        } else if (
          // Every SETTLED status — see the same list in apps/new/[appId]. Without
          // `action_required` this polls at 2s forever on a named blocker.
          ["failed", "cancelled", "partial_failure", "action_required", "rejected"].includes(status)
        ) {
          setErrorMsg(s.failureMessage || w.installFailed);
          setPhase("error");
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(() => {
      if (!stopped) void tick();
    }, 2000);
    return () => {
      stopped = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, deploymentId, baseDomain]);

  const deploy = async () => {
    if (busy) return;
    const host = hostname.trim().toLowerCase();
    if (!host) {
      showToast(m.hostnameRequired, "error");
      return;
    }
    if (!imapHost.trim() || !smtpHost.trim()) {
      showToast(m.hostsRequired, "error");
      return;
    }
    // Deploying the webmail TO Openship Cloud needs a cloud connection — same
    // gate as the deploy wizard / app install, so the pick isn't a dead end.
    if (destination?.deployTarget === "cloud" && !cloudConnected) {
      if (!(await requireCloud("cloud-deploy-target"))) return;
    }
    setBusy(true);
    try {
      const res = await mailApi.webmail.deployExternal({
        hostname: host,
        backend: {
          provider: mailProvider(preset).backendProvider,
          imapHost: imapHost.trim().toLowerCase(),
          imapPort,
          smtpHost: smtpHost.trim().toLowerCase(),
          smtpPort,
        },
        target: {
          deployTarget: destination?.deployTarget ?? "cloud",
          serverId: destination?.deployTarget === "server" ? destination.serverId : undefined,
        },
      });
      setProjectId(res.projectId ?? null);
      setDeploymentId(res.deploymentId ?? null);
      setPhaseLabel(w.progressPreparing);
      setPhase("installing");
    } catch (err) {
      setErrorMsg(getApiErrorMessage(err, w.installFailed));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  // ── Progress / done / error ─────────────────────────────────────────────────
  if (phase === "installing" || phase === "done" || phase === "error") {
    return (
      <CleanDeployProgressCard
        appId="mail"
        title={m.title}
        phase={phase}
        progress={progress}
        phaseLabel={phaseLabel}
        liveUrl={liveUrl}
        errorMsg={errorMsg}
        deploymentId={deploymentId}
        onGoToProject={() => projectId && router.push(`/projects/${projectId}`)}
        onViewBuild={() => deploymentId && router.push(`/build/${deploymentId}`)}
        onRetry={() => setPhase("connect")}
      />
    );
  }

  return (
    <PageContainer outerClassName="pb-20">
      <div className={`mx-auto pt-6 ${phase === "connect" ? "max-w-5xl" : "max-w-2xl"}`}>
        <button
          type="button"
          onClick={() => (phase === "connect" ? setPhase("choose") : router.push("/apps/new"))}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {w.back}
        </button>

        {/* Header. `shrink-0` on the tile for the same reason as the generic app
            wizard: it's a flex child next to wrapping text, so without it the 48px
            tile squeezes narrower than it is tall and the mark reads as stretched. */}
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId="mail" className="size-7" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground">{m.title}</h1>
            <p className="text-sm text-muted-foreground">{m.subtitle}</p>
          </div>
        </div>

        {/* ── Provider chooser ─────────────────────────────────────────────── */}
        {phase === "choose" && (
          <div className="mt-6 space-y-3">
            <OptionCard
              value="self"
              selected={false}
              onSelect={() => router.push("/emails")}
              icon={<Server className="size-4" />}
              label={m.chooseSelf}
              description={m.chooseSelfDesc}
            />
            <OptionCard
              value="connect"
              selected={false}
              onSelect={() => setPhase("connect")}
              icon={<Plug className="size-4" />}
              label={m.chooseConnect}
              description={m.chooseConnectDesc}
            />
          </div>
        )}

        {/* ── Connect-existing form ────────────────────────────────────────── */}
        {phase === "connect" && (
          <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_340px] lg:items-start">
            {/* Left column: provider + hosts */}
            <div className="space-y-5">
              {/* Provider preset */}
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">{m.provider}</h3>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {MAIL_PROVIDERS.map((p) => {
                    const on = preset === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPreset(p.id)}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                          on
                            ? "border-primary/40 bg-primary/[0.06] text-foreground"
                            : "border-border/60 text-muted-foreground hover:bg-muted/40"
                        }`}
                      >
                        {(p.logo || p.logoSrc) && (
                          <AppLogo slug={p.logo} src={p.logoSrc} className="size-4" />
                        )}
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                {/* Every send-only relay needs this, not just SES. Warning only
                    while there's nowhere to read mail from; once IMAP resolves to
                    our own server the split is legitimate, not a problem. */}
                {presetSpec.sendOnly && !ourMailHost && (
                  <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
                    <p>{interpolate(m.sendOnlyNote, { provider: presetSpec.label })}</p>
                    <button
                      type="button"
                      onClick={() => router.push("/emails")}
                      className="mt-1.5 font-medium underline underline-offset-2 hover:opacity-80"
                    >
                      {interpolate(m.sendOnlyNoInbox, { provider: presetSpec.label })}
                    </button>
                  </div>
                )}
                {/* Mailboxes here + send elsewhere is the outbound-relay feature,
                    which does it without a second webmail: one Postfix hop, SPF
                    include published per relayed domain, and scoping down to a
                    single address. Steer there rather than silently competing. */}
                {presetSpec.sendOnly && ourMailHost && (
                  <div className="mt-3 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <p>{interpolate(m.relayNote, { provider: presetSpec.label })}</p>
                    <button
                      type="button"
                      onClick={() =>
                        router.push(mailTabHref(ourMailServer?.id ?? null, "sending"))
                      }
                      className="mt-1.5 font-medium text-foreground underline underline-offset-2 hover:opacity-80"
                    >
                      {m.relayCta}
                    </button>
                  </div>
                )}
              </div>

              {/* Hosts */}
              <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-4">
                <Field label={m.hostname} hint={m.hostnameHint}>
                  <input
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                    placeholder="mail.example.com"
                    className={INPUT}
                  />
                </Field>
                <div>
                  <div className="grid grid-cols-[1fr_auto] gap-3">
                    <Field label={m.imapHost}>
                      <input
                        value={imapHost}
                        onChange={(e) => setImapHost(e.target.value)}
                        placeholder="imap.example.com"
                        className={INPUT}
                      />
                    </Field>
                    <Field label={m.imapPort}>
                      <input
                        type="number"
                        value={imapPort}
                        onChange={(e) => setImapPort(Number(e.target.value))}
                        className={`${INPUT} w-24`}
                      />
                    </Field>
                  </div>
                  {usingOurImap && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {interpolate(m.imapOnOurServer, {
                        host: ourMailHost ?? "",
                        provider: presetSpec.label,
                      })}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-3">
                  <Field label={m.smtpHost}>
                    <input
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.example.com"
                      className={INPUT}
                    />
                  </Field>
                  <Field label={m.smtpPort}>
                    <input
                      type="number"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(Number(e.target.value))}
                      className={`${INPUT} w-24`}
                    />
                  </Field>
                </div>
              </div>
            </div>

            {/* Right column: destination + deploy (sticky) */}
            <div className="space-y-4 lg:sticky lg:top-6">
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">{w.destinationTitle}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{w.destinationHint}</p>
                <div className="mt-4">
                  <AppDestinationPicker value={destination} onChange={setDestination} />
                </div>
              </div>

              <button
                type="button"
                onClick={deploy}
                disabled={busy || !destination}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4 rtl:rotate-180" />}
                {busy ? m.deploying : m.deploy}
              </button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}

const INPUT =
  "w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-muted-foreground">{hint}</span>}
      <span className={hint ? "" : "mt-1.5 block"}>{children}</span>
    </label>
  );
}
