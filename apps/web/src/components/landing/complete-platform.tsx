"use client";

import { useEffect, useState } from "react";
import {
  GitCommitVertical, Eye, Terminal, Boxes, Wand2, Undo2,
  TrendingUp, Scale, Activity, ScrollText, CalendarClock, RefreshCw,
  Globe, Lock, Network, Waypoints, Cable, Zap,
  Database, Layers, Server, HardDrive, Mail, Cloudy,
  LayoutDashboard, Monitor, Bot, KeyRound, FileText,
  Shield, Gauge, FileLock2, ShieldAlert, Fingerprint, BadgeCheck,
  Building2, UserCog, KeySquare, Mailbox, ClipboardList, ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { SectionHeader } from "./section-header";

/**
 * Complete platform - the catalog.
 *
 * Seven capability groups, one on screen at a time. The left rail carries
 * the whole set as a numbered spine so the reader can see the shape of the
 * platform without scrolling; the right column shows only the group they
 * are on. That is the trade the old six-by-six grid could not make: it had
 * to show forty-two things at once, so none of them got any room.
 *
 * The spine advances itself on a timer and yields to a click. Both write to
 * the same `active` index, so there is one source of truth for what is lit,
 * on the rail and on the plinth alike.
 */

type Item = { name: string; desc: string; icon: LucideIcon };
type Group = { n: string; heading: string; mark: React.ReactNode; items: Item[] };

/** How long a group holds before the spine moves on. */
const DWELL_MS = 6000;

/* ─── Category marks - each contains exactly 6 elements ─────────
 * Line-art for the dark plinth. Generous viewBox margins, consistent
 * visual weight across all seven categories. Colour comes from
 * .cat-mark, so the plate owns the palette and the marks stay neutral.
 */
const MARKS = {
  /* Deploy - 6 dots on a smooth ascending bezier (trajectory) */
  deploy: (
    <>
      <path d="M14 82 Q34 76 50 56 T86 18" opacity="0.7" />
      <circle cx="14" cy="82" r="2.1" />
      <circle cx="28" cy="76" r="2.1" />
      <circle cx="42" cy="66" r="2.1" />
      <circle cx="56" cy="52" r="2.1" />
      <circle cx="70" cy="35" r="2.1" />
      <circle cx="86" cy="18" r="2.6" fill="currentColor" />
    </>
  ),
  /* Run - 6 vertical bars on a baseline with caps (activity) */
  run: (
    <>
      <path d="M12 82 L88 82" opacity="0.55" />
      <path d="M20 82 L20 52" strokeLinecap="round" />
      <path d="M32 82 L32 38" strokeLinecap="round" />
      <path d="M44 82 L44 60" strokeLinecap="round" />
      <path d="M56 82 L56 28" strokeLinecap="round" />
      <path d="M68 82 L68 46" strokeLinecap="round" />
      <path d="M80 82 L80 22" strokeLinecap="round" />
    </>
  ),
  /* Connect - hub + 5 nodes arranged on a pentagon (network) */
  connect: (
    <>
      <path d="M50 50 L50 18" opacity="0.55" />
      <path d="M50 50 L80 32" opacity="0.55" />
      <path d="M50 50 L72 80" opacity="0.55" />
      <path d="M50 50 L28 80" opacity="0.55" />
      <path d="M50 50 L20 32" opacity="0.55" />
      <circle cx="50" cy="50" r="3.2" fill="currentColor" />
      <circle cx="50" cy="18" r="2.4" />
      <circle cx="80" cy="32" r="2.4" />
      <circle cx="72" cy="80" r="2.4" />
      <circle cx="28" cy="80" r="2.4" />
      <circle cx="20" cy="32" r="2.4" />
    </>
  ),
  /* Services - 6 stacked layers with subtle isometric step (containers) */
  services: (
    <>
      <rect x="22" y="14" width="56" height="8" rx="1.5" />
      <rect x="18" y="26" width="64" height="8" rx="1.5" />
      <rect x="14" y="38" width="72" height="8" rx="1.5" />
      <rect x="14" y="50" width="72" height="8" rx="1.5" />
      <rect x="14" y="62" width="72" height="8" rx="1.5" />
      <rect x="14" y="74" width="72" height="8" rx="1.5" />
    </>
  ),
  /* Manage - 6 list rows with toggle handles (control surfaces) */
  manage: (
    <>
      <path d="M14 18 L62 18" opacity="0.7" />
      <circle cx="80" cy="18" r="2.6" fill="currentColor" />
      <path d="M14 32 L62 32" opacity="0.7" />
      <circle cx="80" cy="32" r="2.6" />
      <path d="M14 46 L62 46" opacity="0.7" />
      <circle cx="80" cy="46" r="2.6" fill="currentColor" />
      <path d="M14 60 L62 60" opacity="0.7" />
      <circle cx="80" cy="60" r="2.6" />
      <path d="M14 74 L62 74" opacity="0.7" />
      <circle cx="80" cy="74" r="2.6" fill="currentColor" />
      <path d="M14 88 L62 88" opacity="0.7" />
      <circle cx="80" cy="88" r="2.6" />
    </>
  ),
  /* Secure - hexagon (6 sides) with inner check (shield) */
  secure: (
    <>
      <path d="M50 12 L82 30 L82 70 L50 88 L18 70 L18 30 Z" />
      <circle cx="50" cy="12" r="1.8" fill="currentColor" />
      <circle cx="82" cy="30" r="1.8" fill="currentColor" />
      <circle cx="82" cy="70" r="1.8" fill="currentColor" />
      <circle cx="50" cy="88" r="1.8" fill="currentColor" />
      <circle cx="18" cy="70" r="1.8" fill="currentColor" />
      <circle cx="18" cy="30" r="1.8" fill="currentColor" />
      <path d="M40 50 L48 58 L62 42" opacity="0.55" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  /* Collaborate - org tree: 1 owner → 2 → 3 (team hierarchy) */
  team: (
    <>
      <path d="M50 20 L30 46" opacity="0.55" />
      <path d="M50 20 L70 46" opacity="0.55" />
      <path d="M30 54 L20 78" opacity="0.55" />
      <path d="M30 54 L40 78" opacity="0.55" />
      <path d="M70 54 L80 78" opacity="0.55" />
      <circle cx="50" cy="16" r="3.2" fill="currentColor" />
      <circle cx="30" cy="50" r="2.6" />
      <circle cx="70" cy="50" r="2.6" />
      <circle cx="20" cy="82" r="2.2" />
      <circle cx="40" cy="82" r="2.2" />
      <circle cx="80" cy="82" r="2.2" />
    </>
  ),
};

const GROUPS: Group[] = [
  {
    n: "01",
    heading: "Deploy",
    mark: MARKS.deploy,
    items: [
      { name: "Push-to-deploy", desc: "Every commit builds and ships. Branch environments included.", icon: GitCommitVertical },
      { name: "Preview deployments", desc: "Every pull request gets its own URL. Auto-torn down on merge.", icon: Eye },
      { name: "Local builds", desc: "Builds run on your machine. Production servers stay focused.", icon: Terminal },
      { name: "Auto-detected stacks", desc: "Framework, language, package manager, commands - figured out.", icon: Boxes },
      { name: "Smart fixes", desc: "Common failures (missing imports, version drift) diagnosed and patched.", icon: Wand2 },
      { name: "Instant rollbacks", desc: "Every deploy is immutable. Revert to any version in one click.", icon: Undo2 },
    ],
  },
  {
    n: "02",
    heading: "Run",
    mark: MARKS.run,
    items: [
      { name: "Auto-scaling", desc: "Horizontal scaling per service. Up on traffic, down when idle.", icon: TrendingUp },
      { name: "Load balancing", desc: "Health checks, weighted routing, sticky sessions - built in.", icon: Scale },
      { name: "Live monitoring", desc: "CPU, memory, network, disk - real-time charts and alerts.", icon: Activity },
      { name: "Streaming logs", desc: "Live tail across services and replicas. Search, filter, persist.", icon: ScrollText },
      { name: "Scheduled jobs", desc: "Cron-like jobs with retries, visibility, per-run logs.", icon: CalendarClock },
      { name: "Zero-downtime deploys", desc: "Rolling restarts, blue-green, draining connections - automatic.", icon: RefreshCw },
    ],
  },
  {
    n: "03",
    heading: "Connect",
    mark: MARKS.connect,
    items: [
      { name: "Custom domains", desc: "Unlimited apex and subdomains. Wildcards supported.", icon: Globe },
      { name: "Free SSL", desc: "Let's Encrypt by default. Auto-renewing wildcard certificates.", icon: Lock },
      { name: "DNS management", desc: "Visual records and propagation. Verify domains in seconds.", icon: Network },
      { name: "Edge routing", desc: "Global edge, anycast IPs, low-latency routing.", icon: Waypoints },
      { name: "Private networking", desc: "Services talk over an isolated network, no exposed ports.", icon: Cable },
      { name: "WebSockets", desc: "First-class support, persistent connections, sticky routing.", icon: Zap },
    ],
  },
  {
    n: "04",
    heading: "Services",
    mark: MARKS.services,
    items: [
      { name: "PostgreSQL", desc: "Versions 14–17. Daily backups, PITR, scheduled upgrades.", icon: Database },
      { name: "Redis", desc: "Cache or persistent. Cluster mode. Pub/sub and streams.", icon: Layers },
      { name: "MongoDB & MySQL", desc: "Replica sets, sharding, automated upgrades, migration tools.", icon: Server },
      { name: "Object storage", desc: "S3-compatible buckets. Signed URLs, lifecycle rules, replication.", icon: HardDrive },
      { name: "Mail server", desc: "Transactional from your domain. Authentication chain auto-configured.", icon: Mail },
      { name: "CDN", desc: "Static asset acceleration. Cache invalidation on deploy.", icon: Cloudy },
    ],
  },
  {
    n: "05",
    heading: "Manage",
    mark: MARKS.manage,
    items: [
      { name: "CLI", desc: "A single binary covering deploy, logs, secrets, domains, rollbacks.", icon: Terminal },
      { name: "Web dashboard", desc: "Visual deploys, metrics, billing, team access.", icon: LayoutDashboard },
      { name: "Desktop app", desc: "Native Mac and Windows. Push from local, stream logs natively.", icon: Monitor },
      { name: "MCP server", desc: "Drive deploys from AI agents — Claude, Cursor, any MCP client. Standard tools, authenticated.", icon: Bot },
      { name: "Secrets vault", desc: "Encrypted at rest. Environment-scoped. Rotated without redeploying.", icon: KeyRound },
      { name: "Audit log", desc: "Every action, exportable, retained for compliance.", icon: FileText },
    ],
  },
  {
    n: "06",
    heading: "Secure",
    mark: MARKS.secure,
    items: [
      { name: "Firewall", desc: "Default-deny inbound. Per-service policies.", icon: Shield },
      { name: "Rate limiting", desc: "Per-route limits, IP or token based. Burst and sustained.", icon: Gauge },
      { name: "Security headers", desc: "HSTS, CSP, COOP, COEP - production defaults.", icon: FileLock2 },
      { name: "DDoS protection", desc: "Edge-level mitigation, automatic challenge.", icon: ShieldAlert },
      { name: "Encryption", desc: "TLS everywhere, encrypted backups, encrypted secrets.", icon: Fingerprint },
      { name: "Compliance-ready", desc: "Logs and config suitable for SOC 2, ISO 27001.", icon: BadgeCheck },
    ],
  },
  {
    n: "07",
    heading: "Collaborate",
    mark: MARKS.team,
    items: [
      { name: "Workspaces", desc: "Multiple organizations per account — isolated projects, servers, and members. Switch in a click.", icon: Building2 },
      { name: "Team roles", desc: "Owner, admin, member, and a restricted role. Assigned per teammate.", icon: UserCog },
      { name: "Per-resource access", desc: "Grant access down to individual projects and resources - not just broad roles.", icon: KeySquare },
      { name: "Restricted by default", desc: "The restricted role starts with zero access. Every permission is explicit - least privilege.", icon: ShieldCheck },
      { name: "Invitations", desc: "Invite teammates by email. Expiring links, accept flow, per-inviter rate limits.", icon: Mailbox },
      { name: "Member audit", desc: "Every join, role change, and removal recorded and exportable.", icon: ClipboardList },
    ],
  },
];

export function CompletePlatform({ index, total }: { index: number; total: number }) {
  const [active, setActive] = useState(0);
  /* Set once the reader takes over. The timer is a way in for someone who
     is not driving; it has no business fighting someone who is. */
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const id = setInterval(
      () => setActive((i) => (i + 1) % GROUPS.length),
      DWELL_MS,
    );
    return () => clearInterval(id);
  }, [held]);

  return (
    <section className="lp-sec">
      <SectionHeader label="The full platform" index={index} total={total} />

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="cat-grid">
            {/* ── Left rail: the claim, then the whole set as a spine ── */}
            <div className="cat-left">
              <div className="cat-heading">
                <h2 className="cat-title">
                  Forty-two capabilities,<br />one platform.
                </h2>
                <p className="cat-sub">
                  No add-on stores, no plugin marketplaces, no &ldquo;requires an integration with&hellip;&rdquo;.
                </p>
              </div>

              <ol className="cat-spine" role="tablist" aria-label="Capability groups">
                {GROUPS.map((g, i) => (
                  <li key={g.n} className="cat-spine-row">
                    <button
                      type="button"
                      role="tab"
                      aria-current={i === active}
                      aria-selected={i === active}
                      className="cat-spine-item"
                      onClick={() => {
                        setActive(i);
                        setHeld(true);
                      }}
                    >
                      <span className="cat-spine-n">{g.n}</span>
                      <span className="cat-spine-title">{g.heading}</span>
                      <span className="cat-spine-dot" aria-hidden="true" />
                      <span className="cat-spine-progress" aria-hidden="true">
                        {/* Mounted fresh each time the group changes, which is
                            what restarts the fill without touching the DOM. */}
                        {i === active && !held && (
                          <span key={active} className="cat-spine-progress-fill" />
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>

            {/* ── Right: the plinth, then the group's six capabilities ── */}
            <div className="cat-right">
              <div className="cat-stage">
                {GROUPS.map((g, i) => (
                  <div key={g.n} className="cat-card" aria-hidden={i !== active}>
                    <div className="cat-plinth" data-section="dark">
                      <svg
                        className="cat-mark"
                        viewBox="0 0 100 100"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        {g.mark}
                      </svg>
                    </div>
                  </div>
                ))}
              </div>

              <div className="cat-text-stage">
                {GROUPS.map((g, i) => (
                  <div key={g.n} className="cat-text-card" aria-hidden={i !== active}>
                    <div className="cat-text-head">
                      <span className="cat-text-eyebrow">
                        {g.n} &middot; {g.heading}
                      </span>
                      <span className="cat-text-count">
                        {g.items.length} capabilities
                      </span>
                    </div>

                    <div className="cat-items">
                      {g.items.map((it) => {
                        const Icon = it.icon;
                        return (
                          <article key={it.name} className="cat-item">
                            <div className="cat-item-head">
                              <Icon className="cat-item-icon" strokeWidth={1.75} aria-hidden="true" />
                              <h3 className="cat-item-name">{it.name}</h3>
                            </div>
                            <p className="cat-item-desc">{it.desc}</p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
