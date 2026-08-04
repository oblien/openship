import type { LucideIcon } from "lucide-react";

/**
 * Preview placeholder for tabs whose feature isn't shipped yet (Clusters,
 * Networking). Uses the same illustration language as the empty states — a
 * themed monochrome (--th-*) vector that shows what the feature will do — plus
 * a "Coming soon" chip, title, and blurb. Pass `art` for the illustration;
 * `icon` is a fallback tile when no art matches.
 */
export function ComingSoonPanel({
  icon: Icon,
  art,
  title,
  body,
  badge,
}: {
  icon?: LucideIcon;
  art?: "cluster" | "network";
  title: string;
  body: string;
  badge: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {art === "cluster" ? (
        <ClusterArt />
      ) : art === "network" ? (
        <NetworkArt />
      ) : Icon ? (
        <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-muted">
          <Icon className="size-6 text-muted-foreground" />
        </div>
      ) : null}

      <div className="mb-3 inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {badge}
      </div>
      <h3 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
        {title}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

/* ── Illustrations ───────────────────────────────────────────────────
   Same vocabulary as components/overview/ProjectIllustration: --th-* only,
   card/surface stack, thin strokes, dashed connectors, sparkle accents. */

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto mb-8 h-44 w-72 max-w-full">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 260 180" fill="none">
        {children}
      </svg>
    </div>
  );
}

/** A scheduler node distributing deployments across a cluster of servers. */
function ClusterArt() {
  return (
    <Frame>
      {/* Scheduler / control node */}
      <rect x="98" y="22" width="64" height="34" rx="10" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
      <rect x="108" y="32" width="26" height="4" rx="2" fill="var(--th-on-12)" />
      <rect x="108" y="41" width="18" height="4" rx="2" fill="var(--th-on-08)" />
      <circle cx="150" cy="39" r="3.5" fill="var(--th-on-20)" />

      {/* Distribution lines: scheduler → each server */}
      <path d="M118 56 C 108 76, 82 82, 72 100" stroke="var(--th-on-16)" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />
      <path d="M130 56 L 130 100" stroke="var(--th-on-16)" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />
      <path d="M142 56 C 152 76, 178 82, 188 100" stroke="var(--th-on-16)" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />

      {/* Deployment cube mid-transit on the center line */}
      <rect x="123" y="72" width="14" height="14" rx="3.5" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="1.2" />
      <path d="M123 76l7 3 7-3M130 79v7" stroke="var(--th-on-20)" strokeWidth="0.9" fill="none" />

      {/* Three server nodes */}
      {[46, 104, 162].map((x) => (
        <g key={x}>
          <rect x={x} y="100" width="52" height="48" rx="11" fill="var(--th-sf-04)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x={x + 12} y="114" width="28" height="9" rx="3" fill="var(--th-on-06)" stroke="var(--th-on-12)" strokeWidth="0.8" />
          <rect x={x + 12} y="126" width="28" height="9" rx="3" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="0.8" />
          <circle cx={x + 17} cy="118.5" r="1.4" fill="var(--th-on-20)" />
          <circle cx={x + 17} cy="130.5" r="1.4" fill="var(--th-on-16)" />
        </g>
      ))}

      {/* Decorative dots + sparkles */}
      <circle cx="28" cy="70" r="4" fill="var(--th-on-10)" />
      <circle cx="234" cy="66" r="3.5" fill="var(--th-on-12)" />
      <circle cx="242" cy="132" r="4.5" fill="var(--th-on-06)" />
      <circle cx="20" cy="128" r="3" fill="var(--th-on-08)" />
      <path d="M22 96l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
      <path d="M238 100l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-12)" />
    </Frame>
  );
}

/** A routed network mesh — a hub linking nodes with edges + an in-flight packet. */
function NetworkArt() {
  const nodes = [
    { x: 62, y: 52 },
    { x: 196, y: 50 },
    { x: 52, y: 130 },
    { x: 206, y: 128 },
  ];
  return (
    <Frame>
      {/* Edges (behind nodes) */}
      {nodes.map((n, i) => (
        <path key={i} d={`M${n.x + 11} ${n.y + 11} L 130 92`} stroke="var(--th-on-12)" strokeWidth="1.3" strokeDasharray="3 3" fill="none" />
      ))}
      <path d="M73 63 C 110 40, 150 38, 185 61" stroke="var(--th-on-08)" strokeWidth="1.2" fill="none" />

      {/* Central hub */}
      <circle cx="130" cy="92" r="20" fill="var(--th-sf-05)" stroke="var(--th-bd-default)" strokeWidth="1" />
      <circle cx="130" cy="92" r="12" fill="var(--th-card-bg)" stroke="var(--th-on-16)" strokeWidth="1" />
      <path d="M118 92h24M130 80v24" stroke="var(--th-on-20)" strokeWidth="1" />
      <ellipse cx="130" cy="92" rx="6" ry="12" stroke="var(--th-on-16)" strokeWidth="1" fill="none" />

      {/* Outer nodes */}
      {nodes.map((n, i) => (
        <g key={i}>
          <rect x={n.x} y={n.y} width="22" height="22" rx="7" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
          <circle cx={n.x + 11} cy={n.y + 11} r="3" fill="var(--th-on-20)" />
        </g>
      ))}

      {/* In-flight packet on an edge */}
      <circle cx="98" cy="76" r="2.6" fill="var(--th-on-30)" />

      {/* Decorative dots + sparkles */}
      <circle cx="24" cy="92" r="4" fill="var(--th-on-10)" />
      <circle cx="238" cy="92" r="3.5" fill="var(--th-on-10)" />
      <path d="M26 60l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
      <path d="M232 128l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-12)" />
    </Frame>
  );
}
