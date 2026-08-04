import { Fragment } from "react";
import { SectionHeader } from "./section-header";

/**
 * Comparison - grouped table, Openship column highlighted with a tinted rail.
 * Each cell carries a refined status mark (win / loss / neutral) so it reads at
 * a glance without bright colors.
 *
 * Two rules this table lives by:
 *
 * 1. ONLY REAL DIFFERENCES. The shared essentials - git deploys, TLS,
 *    databases, backups, multi-server, cron - are deliberately absent. Everyone
 *    has them, and claiming a win on them is the fastest way to lose a reader.
 *    Where a competitor genuinely matches us the cell is `neutral`, never a
 *    manufactured `loss`. Every claim here is verified against Vercel/Netlify
 *    and Coolify/Dokploy/Dokku as of July 2026.
 *
 * 2. SAY IT THE CALM WAY. These capabilities involve Openship touching servers
 *    the reader already runs, so the wording leads with what they get, not with
 *    what we do to their box. "Works with the proxy you already run", never
 *    "take over your proxy"; "picks up what's already running", never "adopt and
 *    take over". Same fact, no implied risk.
 *
 * Order is commercial, not technical: what you're buying into → what comes
 * included → whether it fits what you already run → how you get out.
 */

type Status = "win" | "loss" | "neutral";
type Cell = { text: string; status: Status };
type Row = { feature: string; openship: Cell; managed: Cell; selfhost: Cell };
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Where it runs, and what stays on",
    rows: [
      {
        feature: "Who runs your workload",
        openship: {
          text: "Openship Cloud runs it, or self-host free on machines you own. One tool, one dashboard, and you can move either direction later.",
          status: "win",
        },
        managed: {
          text: "They run it, and run it well - but managed-only. There is no version you can host yourself.",
          status: "neutral",
        },
        selfhost: {
          text: "Their cloud hosts only the control panel. You still bring, run and pay for every server.",
          status: "loss",
        },
      },
      {
        feature: "What has to stay switched on",
        openship: {
          text: "A native Mac, Windows and Linux app. The control plane runs on your machine only while the app is open - no extra box to keep alive just to deploy.",
          status: "win",
        },
        managed: {
          text: "No desktop app. Everything runs in their cloud, all the time.",
          status: "loss",
        },
        selfhost: {
          text: "No desktop app, and a control-plane server that has to stay up around the clock.",
          status: "loss",
        },
      },
      {
        feature: "Where your source code travels",
        openship: {
          text: "From the desktop app, your folder or repo goes straight to the machine that will run it. Nothing always-on sits in the middle holding your code.",
          status: "win",
        },
        managed: {
          text: "Uploaded to their cloud and built there.",
          status: "loss",
        },
        selfhost: {
          text: "Lands on a long-lived control-plane box first - even when that box is your own.",
          status: "loss",
        },
      },
    ],
  },
  {
    title: "Included, not bolted on",
    rows: [
      {
        feature: "Email from your own domain",
        openship: {
          text: "A real mail server, set up for you: mailboxes, webmail, the SPF/DKIM/DMARC chain, and sending through SES or your own SMTP.",
          status: "win",
        },
        managed: {
          text: "Not included. Add SendGrid, Resend or Postmark and pay per message.",
          status: "loss",
        },
        selfhost: {
          text: "No managed mail server - you run the image and wire up the DNS chain yourself.",
          status: "loss",
        },
      },
      {
        feature: "Traffic rules at the edge",
        openship: {
          text: "Rate limits, country / IP / user-agent blocks and hotlink protection, set per route from the dashboard and applied without a reload.",
          status: "win",
        },
        managed: {
          text: "Firewall and rate limiting exist, gated behind higher plans.",
          status: "neutral",
        },
        selfhost: {
          text: "Possible by hand-writing proxy config; no country rules out of the box.",
          status: "neutral",
        },
      },
      {
        feature: "Who is actually hitting your app",
        openship: {
          text: "Per-route traffic, country breakdown and a live request log, built in.",
          status: "win",
        },
        managed: {
          text: "Strong analytics dashboards, capped or priced by plan.",
          status: "neutral",
        },
        selfhost: {
          text: "Not included - bolt on Grafana, Plausible or an ELK stack.",
          status: "loss",
        },
      },
      {
        feature: "Access control and audit",
        openship: {
          text: "Grant access down to a single project, start teammates at zero permissions, and export a record of every change - on every plan.",
          status: "win",
        },
        managed: {
          text: "Broad team roles; audit trail and SSO on enterprise plans.",
          status: "neutral",
        },
        selfhost: {
          text: "Broad team roles only, with little or no change history.",
          status: "loss",
        },
      },
    ],
  },
  {
    title: "Fits the setup you already have",
    rows: [
      {
        feature: "Servers with things already on them",
        openship: {
          text: "Point it at a server and it picks up the containers already running there. Nothing is rebuilt, nothing is restarted.",
          status: "win",
        },
        managed: {
          text: "Nothing to pick up - you redeploy from source.",
          status: "loss",
        },
        selfhost: {
          text: "Cannot take on an app that is already running; you recreate each one by hand.",
          status: "loss",
        },
      },
      {
        feature: "The proxy you already run",
        openship: {
          text: "Carries on with your existing Traefik, nginx or Caddy on :80 and :443, and the switch is reversible in one step.",
          status: "win",
        },
        managed: {
          text: "Not applicable - their edge, their rules.",
          status: "neutral",
        },
        selfhost: {
          text: "Claims the proxy at install and expects to be the only thing on those ports.",
          status: "loss",
        },
      },
      {
        feature: "Settings that live in your repo",
        openship: {
          text: "openship.json describes build, env, domains, services and resources - reviewed in a pull request like the rest of your code.",
          status: "win",
        },
        managed: {
          text: "vercel.json and netlify.toml do the same thing.",
          status: "neutral",
        },
        selfhost: {
          text: "A Procfile or compose file, but domains, env and resources stay dashboard-only.",
          status: "neutral",
        },
      },
    ],
  },
  {
    title: "If you change your mind",
    rows: [
      {
        feature: "Moving to a different server",
        openship: {
          text: "Move a running app with its volumes and certificates to another machine, then cut traffic over once it checks out.",
          status: "win",
        },
        managed: {
          text: "Not applicable - you do not choose the machine.",
          status: "neutral",
        },
        selfhost: {
          text: "Redeploy on the new box and copy the volumes across by hand.",
          status: "loss",
        },
      },
      {
        feature: "Leaving Openship",
        openship: {
          text: "On your own servers, removing a project deletes our record and nothing else. Containers, data and config keep serving traffic, and Openship can pick them back up later.",
          status: "win",
        },
        managed: {
          text: "Nothing stays behind - the workload only ever existed in their cloud.",
          status: "loss",
        },
        selfhost: {
          text: "Deleting tears the app down, and none of them can re-adopt a running app afterwards.",
          status: "loss",
        },
      },
    ],
  },
];

function StatusMark({ status }: { status: Status }) {
  return (
    <span className={`bench-mark bench-mark--${status}`} aria-hidden="true">
      {status === "win" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M3 7.2 L6 10 L11 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {status === "loss" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M4 4 L10 10 M10 4 L4 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {status === "neutral" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M3.5 7 L10.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

/** Flattened so the board can tell which row is the last one overall - the
 *  Openship column's tint has to close on it, and a per-group last row
 *  would close it four times. */
const ROWS = GROUPS.flatMap((g) =>
  g.rows.map((r, i) => ({ ...r, group: i === 0 ? g.title : null })),
);

export function Comparison({ index, total }: { index: number; total: number }) {
  return (
    <section className="lp-sec">
      <SectionHeader label="Straight comparison" index={index} total={total} />

      <div className="lp-band">
        <div className="lp-band-in">
          <div className="bench-headline">
            <h2 className="bench-headline-title">
              Where Openship is<br />genuinely different.
            </h2>
            <p className="bench-headline-sub">
              Git deploys, TLS, databases, backups, cron &mdash; every tool here has those, so
              they are not on this list. What is below is where the choice actually changes
              what you can do, and what it costs you to change your mind.
            </p>
          </div>
        </div>
      </div>

      <div className="lp-band">
        <div className="lp-band-in">
          {/* The Openship column is one connected card that lifts above and
              below the surrounding hairlines, so the eye finds the verdict
              before it starts reading rows. */}
          <div className="bench-board">
            <div className="bench-row bench-row--head">
              <div className="bench-cell bench-cell--label">
                <span className="bench-vendor">Feature</span>
              </div>
              <div className="bench-cell bench-cell--sm bench-cell--sm-head">
                <span className="bench-badge">Best</span>
                <span className="bench-vendor bench-vendor--sm">Openship</span>
              </div>
              <div className="bench-cell">
                <span className="bench-vendor">Managed (Vercel, Netlify)</span>
              </div>
              <div className="bench-cell">
                <span className="bench-vendor">Self-host (Coolify, Dokploy, Dokku)</span>
              </div>
            </div>

            {ROWS.map((r, i) => (
              <Fragment key={r.feature}>
                {r.group && (
                  <div className="bench-row bench-row--group">
                    <div className="bench-cell bench-cell--label">
                      <span className="bench-group">{r.group}</span>
                    </div>
                    <div className="bench-cell bench-cell--sm" />
                    <div className="bench-cell" />
                    <div className="bench-cell" />
                  </div>
                )}

                <div
                  className="bench-row"
                  data-last={i === ROWS.length - 1 ? "true" : undefined}
                >
                  <div className="bench-cell bench-cell--label">
                    <span className="bench-feature">{r.feature}</span>
                  </div>
                  <div
                    className={`bench-cell bench-cell--sm${
                      i === ROWS.length - 1 ? " bench-cell--sm-foot" : ""
                    }`}
                  >
                    <StatusMark status={r.openship.status} />
                    <span>{r.openship.text}</span>
                  </div>
                  <div className="bench-cell">
                    <StatusMark status={r.managed.status} />
                    <span>{r.managed.text}</span>
                  </div>
                  <div className="bench-cell">
                    <StatusMark status={r.selfhost.status} />
                    <span>{r.selfhost.text}</span>
                  </div>
                </div>
              </Fragment>
            ))}
          </div>

          <p className="bench-foot">
            Compared against the shipping versions of each tool, July 2026. A dash means
            that tool genuinely matches Openship, or that the row does not apply to it.
            We would rather score a row even than invent a cross.
          </p>
        </div>
      </div>
    </section>
  );
}
