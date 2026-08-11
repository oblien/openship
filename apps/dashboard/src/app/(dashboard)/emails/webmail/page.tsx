"use client";

/**
 * /emails/webmail — the rail's Webmail entry, and nothing more than a signpost.
 *
 * Webmail (Zero) ships as an ORDINARY catalog app through the standard deploy
 * pipeline (the `webmail` template, installed by
 * `apps/api/src/modules/mail/webmail/webmail-install.service.ts`), so there is
 * deliberately no webmail admin panel here: logs, redeploy, domains, env and
 * delete all already exist in the projects UI, and the install already exists at
 * /deploy/mail. This route only answers the question the rail can't, then gets
 * out of the way:
 *
 *   ambiguous (2+ mail servers, no ?serverId=) → ask which mail domain
 *   project exists                             → /projects/<id>   (the projects UI)
 *   no project                                 → install offer    (→ /deploy/mail)
 *
 * "Installed on the box but no project row" (adopted server, rebuilt openship DB)
 * is NOT a fourth state: there is nothing here to manage, so it lands on the same
 * install offer — deploying stands up the catalog app on its own volume, and the
 * mail server's link is re-stamped to it. The dead-end card that used to render
 * there told the operator what was wrong and gave them no way out.
 *
 * The resolve happens here rather than in the rail so the sidebar doesn't have to
 * carry a status fetch on every page in mail view; the cost is paid only when
 * someone actually clicks Webmail.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, ChevronRight, Inbox, Loader2, MailPlus, Upload } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { Skeleton } from "../_components/admin/_shared/skeleton";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { mailApi } from "@/lib/api";
import { needsMailServerChoice, pickActiveMailServer } from "@/lib/mail-active-server";

type MailServerRow = Awaited<
  ReturnType<typeof mailApi.listMailServers>
>["servers"][number];

type WebmailView =
  | { kind: "loading" }
  /** No mail server registered at all — webmail has nothing to sign in to. */
  | { kind: "no-server" }
  /** 2+ installed mail servers and no hint: which domain's webmail? */
  | { kind: "choose"; servers: MailServerRow[] }
  /** The mail server itself isn't finished — webmail would have no backend. */
  | { kind: "incomplete"; server: MailServerRow }
  | { kind: "opening"; projectId: string }
  /**
   * No project to manage. `runningUrl` is set when the box says webmail IS live
   * (adopted / deployed outside this instance) — installing adopts it, so the
   * offer stands either way and the live URL is offered alongside, not instead.
   */
  | { kind: "install"; server: MailServerRow; runningUrl: string | null; runningHost: string };

export default function WebmailPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { t } = useI18n();
  const tw = t.emailsAdmin.webmail;
  const hintedServerId = searchParams.get("serverId");
  const [view, setView] = useState<WebmailView>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Always listed, even with a ?serverId= in hand: it's a plain DB read (no
      // SSH), it's what proves the hint names a server this instance still knows,
      // and it's the difference between asking which domain and guessing.
      const servers = await mailApi
        .listMailServers()
        .then((r) => r.servers)
        .catch(() => [] as MailServerRow[]);
      if (cancelled) return;

      if (servers.length === 0) {
        setView({ kind: "no-server" });
        return;
      }
      if (needsMailServerChoice(servers, hintedServerId)) {
        setView({ kind: "choose", servers });
        return;
      }
      // Same rule the rail scopes by, so clicking Webmail can't land on a
      // different server than the one named above it in the sidebar.
      const server = pickActiveMailServer(servers, hintedServerId);
      if (!server) {
        setView({ kind: "no-server" });
        return;
      }
      if (!server.completed) {
        setView({ kind: "incomplete", server });
        return;
      }

      // A failed read returns the "no install" shape (the API swallows an
      // unreachable box), so this falls through to the install offer — the same
      // thing the overview tab's webmail CTA does on an unreachable server.
      const status = await mailApi.getStatus(server.id).catch(() => null);
      if (cancelled) return;
      const webmail = status?.webmail;

      // Deliberately NOT gated on `installed`: an interrupted deploy leaves a
      // project whose build logs are the whole reason to go there.
      if (webmail?.projectId) {
        setView({ kind: "opening", projectId: webmail.projectId });
        return;
      }
      setView({
        kind: "install",
        server,
        runningUrl: webmail?.installed ? webmail.url || null : null,
        runningHost: webmail?.hostname ?? "",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [hintedServerId]);

  // `replace`, not `push`: this route is a signpost, so Back should go wherever
  // the operator came from rather than bounce off it again.
  useEffect(() => {
    if (view.kind === "opening") router.replace(`/projects/${view.projectId}`);
  }, [view, router]);

  const label = (s: MailServerRow) => s.domain || s.name;

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{tw.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{tw.subtitle}</p>
      </div>

      {view.kind === "loading" && (
        <div className="rounded-2xl border border-border/50 bg-card px-6 py-12">
          <div className="mx-auto max-w-sm space-y-3 text-center">
            <Skeleton className="mx-auto h-32 w-48 rounded-2xl" />
            <Skeleton className="mx-auto h-5 w-44" />
            <Skeleton className="mx-auto h-3 w-72 max-w-full" />
          </div>
        </div>
      )}

      {/* Redirecting to the project — a spinner, not an empty state: there is
          nothing here to act on and the URL is already changing. */}
      {view.kind === "opening" && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border/50 bg-card px-6 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {tw.opening}
        </div>
      )}

      {view.kind === "no-server" && (
        <Offer
          title={tw.noServerTitle}
          body={tw.noServerBody}
          action={
            <Link href="/emails" className={primaryButtonClass}>
              <MailPlus className="size-4" />
              {t.dashboard.nav.mailSetup}
            </Link>
          }
        />
      )}

      {view.kind === "incomplete" && (
        <Offer
          title={tw.incompleteTitle}
          body={interpolate(tw.incompleteBody, { server: label(view.server) })}
          action={
            <Link
              href={`/emails?serverId=${encodeURIComponent(view.server.id)}`}
              className={primaryButtonClass}
            >
              {tw.incompleteAction}
              <ChevronRight className="size-4 rtl:rotate-180" />
            </Link>
          }
        />
      )}

      {view.kind === "install" && (
        <Offer
          // Same action either way, but "isn't installed" over a webmail the
          // operator can click through to is simply false.
          title={view.runningUrl ? tw.adoptTitle : tw.installTitle}
          body={tw.installBody}
          action={
            <Link
              href={`/deploy/mail?serverId=${encodeURIComponent(view.server.id)}`}
              className={primaryButtonClass}
            >
              <Upload className="size-4" />
              {t.emailsAdmin.overview.deployWebmail}
            </Link>
          }
          note={
            view.runningUrl ? (
              <>
                {interpolate(tw.runningNote, { hostname: view.runningHost })}{" "}
                <a
                  href={view.runningUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                >
                  {t.emailsAdmin.overview.openWebmail}
                  <ArrowUpRight className="size-3.5" strokeWidth={2.25} />
                </a>
              </>
            ) : null
          }
        />
      )}

      {view.kind === "choose" && (
        <div className="rounded-2xl border border-border/50 bg-card p-6">
          <h2 className="text-base font-semibold text-foreground">{tw.chooseTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{tw.chooseBody}</p>
          <div className="mt-4 space-y-2">
            {view.servers.map((s) => (
              <Link
                key={s.id}
                href={`/emails/webmail?serverId=${encodeURIComponent(s.id)}`}
                className="group flex items-center gap-3 rounded-xl border border-border/50 bg-background/40 px-4 py-3 transition-colors hover:border-border hover:bg-muted/40"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Inbox className="size-4" strokeWidth={1.8} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{label(s)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.completed ? s.host : t.chrome.mailRail.setupIncomplete}
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground rtl:rotate-180" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25";

/** The house empty state: illustration, one sentence, one button. */
function Offer({
  title,
  body,
  action,
  note,
}: {
  title: string;
  body: string;
  action: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card px-6 pb-10 text-center">
      <WebmailIllustration />
      <h2 className="mb-2 text-lg font-medium text-foreground/80">{title}</h2>
      <p className="mx-auto mb-8 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
      <div className="flex justify-center">{action}</div>
      {note && (
        <p className="mx-auto mt-6 max-w-md text-xs leading-relaxed text-muted-foreground/80">
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * A mail client in a browser window — same 260×180 vocabulary and `--th-*` tokens
 * as the projects / deployments empty states, so this page reads as part of the
 * set rather than as a one-off.
 */
function WebmailIllustration() {
  return (
    <div className="relative mx-auto h-44 w-64">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 260 180" fill="none">
        {/* Window stack */}
        <rect x="42" y="46" width="150" height="94" rx="14" fill="var(--th-sf-04)" />
        <rect
          x="34"
          y="34"
          width="150"
          height="94"
          rx="14"
          fill="var(--th-card-bg)"
          stroke="var(--th-bd-default)"
          strokeWidth="1"
        />

        {/* Chrome bar */}
        <rect x="34" y="34" width="150" height="24" rx="12" fill="var(--th-sf-05)" />
        <circle cx="49" cy="46" r="3.5" fill="#ef4444" fillOpacity="0.6" />
        <circle cx="60" cy="46" r="3.5" fill="#eab308" fillOpacity="0.6" />
        <circle cx="71" cy="46" r="3.5" fill="#22c55e" fillOpacity="0.6" />
        <rect x="86" y="42" width="86" height="8" rx="4" fill="var(--th-on-06)" />

        {/* Folder rail */}
        <rect x="42" y="66" width="34" height="54" rx="7" fill="var(--th-on-05)" />
        <rect x="48" y="73" width="22" height="4" rx="2" fill="var(--th-on-16)" />
        <rect x="48" y="83" width="16" height="3.5" rx="1.75" fill="var(--th-on-10)" />
        <rect x="48" y="92" width="19" height="3.5" rx="1.75" fill="var(--th-on-10)" />
        <rect x="48" y="101" width="14" height="3.5" rx="1.75" fill="var(--th-on-10)" />

        {/* Message list */}
        <rect x="84" y="66" width="90" height="16" rx="5" fill="var(--th-sf-05)" />
        <circle cx="93" cy="74" r="3" fill="var(--th-on-30)" />
        <rect x="102" y="70" width="46" height="3.5" rx="1.75" fill="var(--th-on-16)" />
        <rect x="102" y="77" width="62" height="3" rx="1.5" fill="var(--th-on-08)" />

        <rect x="84" y="86" width="90" height="16" rx="5" fill="var(--th-sf-04)" />
        <circle cx="93" cy="94" r="3" fill="var(--th-on-12)" />
        <rect x="102" y="90" width="38" height="3.5" rx="1.75" fill="var(--th-on-12)" />
        <rect x="102" y="97" width="56" height="3" rx="1.5" fill="var(--th-on-06)" />

        <rect x="84" y="106" width="90" height="14" rx="5" fill="var(--th-sf-04)" />
        <circle cx="93" cy="113" r="3" fill="var(--th-on-12)" />
        <rect x="102" y="111" width="44" height="3" rx="1.5" fill="var(--th-on-08)" />

        {/* Envelope badge */}
        <circle cx="184" cy="126" r="15" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
        <rect x="176" y="120" width="16" height="12" rx="2.5" fill="var(--th-on-10)" />
        <path d="M176.5 121.5l7.5 6 7.5-6" stroke="var(--th-on-30)" strokeWidth="1.5" fill="none" strokeLinecap="round" />

        {/* Dashed plus — the install affordance */}
        <circle cx="215" cy="72" r="21" fill="var(--th-on-05)" />
        <circle
          cx="215"
          cy="72"
          r="15"
          fill="var(--th-card-bg)"
          stroke="var(--th-on-20)"
          strokeWidth="2"
          strokeDasharray="4 3"
        />
        <path
          d="M215 65v14M208 72h14"
          stroke="var(--th-on-40)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M187 76 Q 193 74 196 72" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />

        {/* Decorative */}
        <circle cx="18" cy="62" r="4" fill="var(--th-on-10)" />
        <circle cx="26" cy="138" r="6" fill="var(--th-on-08)" />
        <circle cx="238" cy="36" r="3" fill="var(--th-on-12)" />
        <circle cx="243" cy="128" r="5" fill="var(--th-on-06)" />
        <path d="M14 102l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
        <path d="M222 154l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
      </svg>
    </div>
  );
}
