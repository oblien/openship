/**
 * How it works - the deploy mechanism as a five-step flow.
 *
 * This is the differentiator the feature grids only imply: builds run on YOUR
 * machine, ship to YOUR servers over SSH with no agent installed, start as
 * immutable containers, swap with zero downtime, and are drivable from
 * anywhere (CLI / dashboard / desktop / AI agent over MCP).
 */

const STEPS = [
  {
    n: "01",
    title: "Connect",
    body: "Link a Git repo and pick a target — Openship Cloud or your own server over SSH. Nothing is installed on your box: no agent, no daemon, no dashboard.",
  },
  {
    n: "02",
    title: "Build",
    body: "On every push the image builds on your machine (or in the cloud), runs your tests, and is tagged as an immutable, versioned artifact. Your production servers stay focused on serving.",
  },
  {
    n: "03",
    title: "Ship",
    body: "The built image streams to the target over SSH and starts as a fresh container on an isolated private network — no exposed ports, no hand-written Docker or Compose.",
  },
  {
    n: "04",
    title: "Route",
    body: "Your domains are wired through OpenResty with automatic Let's Encrypt SSL, then traffic swaps to the new container with zero downtime. The previous version stays ready for rollback.",
  },
  {
    n: "05",
    title: "Operate",
    body: "Stream logs, watch metrics, and roll back to any previous version in one click — from the CLI, the web dashboard, the desktop app, or an AI agent over MCP.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="hiw-section">
      <div className="hiw-container">
        <header className="hiw-head">
          <p className="hiw-eyebrow">How it works</p>
          <h2 className="hiw-title">
            From git push to live,<br />on your infrastructure.
          </h2>
          <p className="hiw-sub">
            No agent on your servers, no black box. Here&rsquo;s the exact path your
            code takes — and why your production machines never build.
          </p>
        </header>

        <ol className="hiw-flow">
          {STEPS.map((s) => (
            <li key={s.n} className="hiw-step">
              <div className="hiw-step-rail">
                <span className="hiw-step-n">{s.n}</span>
              </div>
              <div className="hiw-step-body">
                <h3 className="hiw-step-title">{s.title}</h3>
                <p className="hiw-step-desc">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
