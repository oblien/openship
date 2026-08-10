/**
 * Roadmap hero vector — a wide, animated line-art "journey": a route threading
 * milestone waypoints that light up from shipped → exploring, with a glowing
 * traveller sliding along it. Pure SVG + CSS (see roadmap.css `rm-art-*`),
 * theme-driven via --th-* tokens; motion is disabled under reduced-motion.
 */

// One smooth route reused by the base line, the "done" overlay, and the traveller.
const ROUTE = "M40 96 C 190 40, 300 128, 460 92 S 720 44, 900 92";

type WP = { x: number; y: number; kind: "done" | "active" | "todo"; delay: string };
const WAYPOINTS: WP[] = [
  { x: 40, y: 96, kind: "done", delay: "0s" },
  { x: 250, y: 74, kind: "done", delay: "0.5s" },
  { x: 460, y: 92, kind: "active", delay: "1s" },
  { x: 675, y: 66, kind: "todo", delay: "1.5s" },
  { x: 900, y: 92, kind: "todo", delay: "2s" },
];

export function RoadmapHeroArt() {
  return (
    <div className="rm-art" aria-hidden="true">
      <svg viewBox="0 0 940 150" fill="none" className="rm-art-svg">
        {/* base route */}
        <path className="rm-art-route" d={ROUTE} pathLength={100} />
        {/* completed portion (shipped → in progress) */}
        <path className="rm-art-done" d={ROUTE} pathLength={100} />
        {/* glowing traveller sliding the full route */}
        <path className="rm-art-travel" d={ROUTE} pathLength={100} />

        {/* waypoints */}
        {WAYPOINTS.map((w, i) => (
          <g key={i} transform={`translate(${w.x} ${w.y})`} className={`rm-wp rm-wp--${w.kind}`}>
            <circle className="rm-wp-halo" r={13} style={{ animationDelay: w.delay }} />
            <circle className="rm-wp-core" r={6} />
          </g>
        ))}

        {/* destination flag at the last waypoint */}
        <g transform="translate(900 92)" className="rm-art-flag">
          <path d="M0 -6 L0 -30" />
          <path className="rm-art-flag-fill" d="M0 -30 L18 -25 L0 -20 Z" />
        </g>

        {/* decorative floating sparks */}
        <circle className="rm-art-spark" cx={150} cy={26} r={2.5} style={{ animationDelay: "0s" }} />
        <circle className="rm-art-spark" cx={560} cy={30} r={2} style={{ animationDelay: "0.8s" }} />
        <circle className="rm-art-spark" cx={790} cy={120} r={2.5} style={{ animationDelay: "1.4s" }} />
        <circle className="rm-art-spark" cx={360} cy={122} r={2} style={{ animationDelay: "2s" }} />
      </svg>
    </div>
  );
}
