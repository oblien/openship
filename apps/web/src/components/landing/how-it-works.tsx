import { SectionHeader } from "./section-header";

/**
 * How it works - the deploy mechanism as a five-step flow.
 *
 * This is the differentiator the feature grids only imply: builds run on YOUR
 * machine, ship to YOUR servers over SSH with no agent installed, start as
 * immutable containers, swap with zero downtime, and are drivable from
 * anywhere (CLI / dashboard / desktop / AI agent over MCP).
 *
 * Steps 01-04 are the build, and each gets a cell of the bento: a schematic
 * above, its copy below. Step 05 is what the first four are for, so it takes
 * the full width and the only drenched plate in the section - the layout
 * makes the argument before the words do.
 */

/* Schematics - line-art on a tinted panel, one per build step. Same
 * 100x62 field and same stroke weight throughout, so four different
 * diagrams still read as one set. */
const SCHEMATICS = {
  /* Connect - a repo and a target, joined, with nothing in between */
  connect: (
    <>
      <rect x="8" y="21" width="26" height="20" rx="1" />
      <path d="M14 27h14M14 31h9" opacity=".5" />
      <rect x="66" y="21" width="26" height="20" rx="1" />
      <path d="M72 27h14M72 31h9" opacity=".5" />
      <path d="M34 31h32" strokeDasharray="3 3" opacity=".65" />
      <circle cx="50" cy="31" r="2.4" fill="currentColor" />
    </>
  ),
  /* Build - source folded down into one immutable, versioned artifact */
  build: (
    <>
      <path d="M28 10h44M24 17h52M20 24h60" opacity=".45" />
      <path d="M50 30v7" opacity=".6" />
      <rect x="32" y="37" width="36" height="16" rx="1" />
      <path d="M38 45h10" opacity=".55" />
      <circle cx="61" cy="45" r="2.2" fill="currentColor" />
    </>
  ),
  /* Ship - the artifact crossing one boundary, landing as a container */
  ship: (
    <>
      <rect x="6" y="23" width="22" height="16" rx="1" />
      <path d="M44 31h22m0 0-6-5m6 5-6 5" />
      <path d="M36 8v46" strokeDasharray="3 4" opacity=".55" />
      <rect x="72" y="19" width="22" height="24" rx="1" />
      <path d="M72 26h22" opacity=".5" />
      <circle cx="76" cy="22.5" r="1.2" fill="currentColor" />
    </>
  ),
  /* Route - one domain terminating at the edge, fanned to the replicas */
  route: (
    <>
      <rect x="6" y="24" width="26" height="14" rx="1" />
      <path d="M32 31h16" opacity=".6" />
      <path d="M48 17h18v28H48z" />
      <path d="M57 22v6m-3-3h6" opacity=".55" />
      <path d="M66 31h10m-10-9 10-9m-10 18 10 9" opacity=".6" />
      <circle cx="80" cy="13" r="3" />
      <circle cx="80" cy="31" r="3" />
      <circle cx="80" cy="49" r="3" />
    </>
  ),
};

const STEPS = [
  {
    n: "01",
    title: "Connect",
    body: "Link a Git repo and pick a target — Openship Cloud or your own server over SSH. Nothing is installed on your box: no agent, no daemon, no dashboard.",
    mark: SCHEMATICS.connect,
  },
  {
    n: "02",
    title: "Build",
    body: "On every push the image builds on your machine (or in the cloud), runs your tests, and is tagged as an immutable, versioned artifact. Your production servers stay focused on serving.",
    mark: SCHEMATICS.build,
  },
  {
    n: "03",
    title: "Ship",
    body: "The built image streams to the target over SSH and starts as a fresh container on an isolated private network — no exposed ports, no hand-written Docker or Compose.",
    mark: SCHEMATICS.ship,
  },
  {
    n: "04",
    title: "Route",
    body: "Your domains are wired through OpenResty with automatic Let's Encrypt SSL, then traffic swaps to the new container with zero downtime. The previous version stays ready for rollback.",
    mark: SCHEMATICS.route,
  },
];

/** The payoff. Kept out of STEPS because it is laid out as its own plate. */
const PAYOFF = {
  n: "05",
  title: "Operate",
  body: "Stream logs, watch metrics, and roll back to any previous version in one click — from the CLI, the web dashboard, the desktop app, or an AI agent over MCP.",
};

export function HowItWorks({ index, total }: { index: number; total: number }) {
  return (
    <section id="how-it-works" className="lp-sec">
      <SectionHeader label="How it works" index={index} total={total} />

      {/* Title and its qualifier share one baseline rather than stacking:
          the sub is a footnote to the claim, not the next line of it. */}
      <div className="lp-band">
        <div className="lp-band-in">
          <div className="hiw-headline">
            <h2 className="hiw-headline-title">
              From git push to live,<br />on your infrastructure.
            </h2>
            <p className="hiw-headline-sub">
              No agent on your servers, no black box. Here&rsquo;s the exact path your
              code takes — and why your production machines never build.
            </p>
          </div>
        </div>
      </div>

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="hiw-bento">
            {STEPS.map((s) => (
              <article key={s.n} className="hiw-cell">
                <div className="hiw-illo">
                  <svg
                    className="hiw-mark"
                    viewBox="0 0 100 62"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {s.mark}
                  </svg>
                </div>
                {/* The step name is the eyebrow, not a second heading above
                    the same word: these steps are named in one word, so a
                    title line would only echo the label beside the number. */}
                <div className="hiw-copy">
                  <h3 className="hiw-copy-eyebrow">
                    {s.n} / {s.title}
                  </h3>
                  <p className="hiw-copy-desc">{s.body}</p>
                </div>
              </article>
            ))}

            <div className="hiw-payoff" data-section="dark">
              {/* On the payoff plate the step's own sentence is the headline.
                  It is the claim the four cells above were building to, so it
                  is set as one, not demoted to body copy under a label. */}
              <div className="hiw-payoff-text">
                <h3 className="hiw-payoff-eyebrow">
                  {PAYOFF.n} / {PAYOFF.title}
                </h3>
                <p className="hiw-payoff-title">{PAYOFF.body}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
