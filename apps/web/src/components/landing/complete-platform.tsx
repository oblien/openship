import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FEATURES, CATEGORY_ORDER, categoryId } from "@/lib/features";
import { DarkSection } from "./dark-section";

/**
 * Complete platform - dark section, alternating with the light Features
 * section above. Seven capability groups with big numbered anchors and an
 * abstract category marks. Counts and links come from the shared catalog.
 */

/* ─── Category marks - each contains exactly 6 elements ─────────
 * Refined line-art for the dark surface. Generous viewBox margins,
 * consistent visual weight across all six categories. Color comes
 * from the .cp-group-mark class - a soft lavender, not raw white.
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

const marks = [
  MARKS.deploy,
  MARKS.run,
  MARKS.connect,
  MARKS.services,
  MARKS.manage,
  MARKS.secure,
  MARKS.team,
];
const GROUPS = CATEGORY_ORDER.map((category, index) => ({
  n: String(index + 1).padStart(2, "0"),
  heading: category,
  mark: marks[index],
  items: FEATURES.filter((feature) => feature.category === category),
}));

export function CompletePlatform() {
  return (
    <section className="cp-outer">
      <DarkSection>
        <div className="cp-container">
          <header className="cp-head">
            <p className="cp-eyebrow">The full platform</p>
            <h2 className="cp-title">
              {FEATURES.length === 42 ? "Forty-two" : FEATURES.length} capabilities,
              <br />
              one platform.
            </h2>
            <p className="cp-sub">
              Build, deploy, automate, and operate from one place. Explore each capability, how it
              works, and where it is available.
            </p>
            <Link href="/features" className="cp-all-link">
              Explore all features <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </header>

          <div className="cp-stack">
            {GROUPS.map((g) => (
              <section key={g.n} className="cp-group">
                <div className="cp-group-rail">
                  <span className="cp-group-n">{g.n}</span>
                  <h3 className="cp-group-heading">
                    <Link href={`/features#${categoryId(g.heading)}`}>{g.heading}</Link>
                  </h3>

                  <svg
                    className="cp-group-mark"
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

                  <span className="cp-group-count">
                    <span className="cp-group-count-n">{g.items.length}</span>
                    <span className="cp-group-count-label">capabilities</span>
                  </span>
                </div>
                <div className="cp-grid">
                  {g.items.map((it) => {
                    const Icon = it.icon;
                    return (
                      <Link key={it.slug} href={`/features/${it.slug}`} className="cp-item">
                        <div className="cp-item-head">
                          <Icon className="cp-item-icon" strokeWidth={1.75} aria-hidden="true" />
                          <h4 className="cp-item-name">{it.title}</h4>
                          <ArrowRight className="cp-item-arrow" aria-hidden="true" />
                        </div>
                        <p className="cp-item-desc">{it.tagline}</p>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </DarkSection>
    </section>
  );
}
