import { useCopy } from "@/i18n/use-copy";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";

/**
 * Comparison - open grouped rows with a soft OpenShip column highlight.
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
 * 2. SAY IT THE CALM WAY. These capabilities involve OpenShip touching servers
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
type Group = { title: string; illustration: FeatureIllustrationName; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Where it runs, and what stays on",
    illustration: "deploy-anywhere",
    rows: [
      {
        feature: "Who runs your workload",
        openship: {
          text: "OpenShip Cloud runs it, or self-host free on machines you own. One tool, one dashboard, and you can move either direction later.",
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
    illustration: "compose-multi-service",
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
    illustration: "server-management",
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
    illustration: "migration-import",
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
        feature: "Leaving OpenShip",
        openship: {
          text: "On your own servers, removing a project deletes our record and nothing else. Containers, data and config keep serving traffic, and OpenShip can pick them back up later.",
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
    <span className={`cmp-mark cmp-mark--${status}`} aria-hidden="true">
      {status === "win" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path
            d="M3 7.2 L6 10 L11 4.4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {status === "loss" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path
            d="M4 4 L10 10 M10 4 L4 10"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
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

function ComparisonValue({
  label,
  text,
  status,
  highlighted = false,
}: {
  label: string;
  text: string;
  status: Status;
  highlighted?: boolean;
}) {
  return (
    <div className={`cmp-cell${highlighted ? " cmp-cell--win" : ""}`} role="cell">
      <span className="cmp-provider-label">{label}</span>
      <StatusMark status={status} />
      <span>{text}</span>
    </div>
  );
}

export function Comparison() {
  const copy = useCopy();

  return (
    <section id="comparison" className="cmp-section" aria-labelledby="comparison-title">
      <div className="site-container cmp-container">
        <header className="cmp-head">
          <div>
            <p className="cmp-eyebrow">{copy("Straight comparison")}</p>
            <h2 id="comparison-title" className="cmp-title">
              {copy("Where OpenShip is")}
              <br />
              <span>{copy("genuinely different.")}</span>
            </h2>
          </div>
          <p className="cmp-sub">
            {copy(
              "Git deploys, TLS, databases, backups, cron — every tool here has those, so they are not on this list. What is below is where the choice actually changes what you can do, and what it costs you to change your mind.",
            )}
          </p>
        </header>

        <div className="cmp" role="table" aria-labelledby="comparison-title" aria-colcount={4}>
          {/* Header */}
          <div className="cmp-row cmp-row--head" role="row">
            <div className="cmp-cell cmp-cell--feature" role="columnheader">{copy("Feature")}</div>
            <div className="cmp-cell cmp-cell--win" role="columnheader">
              <span className="cmp-brand"><span className="cmp-brand-mark" aria-hidden="true" />OpenShip</span>
            </div>
            <div className="cmp-cell" role="columnheader">
              {copy("Managed")}
              <bdi className="cmp-providers" dir="ltr">
                Vercel · Netlify
              </bdi>
            </div>
            <div className="cmp-cell" role="columnheader">
              {copy("Self-host")}
              <bdi className="cmp-providers" dir="ltr">
                Coolify · Dokploy · Dokku
              </bdi>
            </div>
          </div>

          {/* Body, grouped */}
          {GROUPS.map((g) => (
            <div key={g.title} className="cmp-body-group" role="rowgroup">
              <div className="cmp-group" role="row">
                <div className="cmp-group-heading" role="cell" aria-colspan={4}>
                  <FeatureIllustration name={g.illustration} className="cmp-illustration" />
                  <h3>{copy(g.title)}</h3>
                </div>
              </div>
              {g.rows.map((r) => (
                <div key={r.feature} className="cmp-row" role="row">
                  <div className="cmp-cell cmp-cell--feature" role="rowheader">{copy(r.feature)}</div>
                  <ComparisonValue
                    label="OpenShip"
                    status={r.openship.status}
                    text={copy(r.openship.text)}
                    highlighted
                  />
                  <ComparisonValue
                    label={copy("Managed")}
                    status={r.managed.status}
                    text={copy(r.managed.text)}
                  />
                  <ComparisonValue
                    label={copy("Self-host")}
                    status={r.selfhost.status}
                    text={copy(r.selfhost.text)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>

        <p className="cmp-foot">
          {copy(
            "Compared against the shipping versions of each tool, July 2026. A dash means that tool genuinely matches OpenShip, or that the row does not apply to it. We would rather score a row even than invent a cross.",
          )}
        </p>
      </div>
    </section>
  );
}
