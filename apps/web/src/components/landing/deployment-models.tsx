/**
 * Deployment models - three big numbered panels. Middle (Hybrid) is the
 * inverted dark panel for visual rhythm. Big "01/02/03" as type-as-design.
 */

const MODELS = [
  {
    n: "01",
    tag: "Managed",
    title: "Openship Cloud",
    lead:
      "Sign up, point at a repository, ship. Zero infrastructure decisions. Multi-region by default. Auto-scaling per service.",
    points: [
      "Multi-region edge - us, eu, apac, more",
      "Auto-scaling, zero-downtime rolling deploys",
      "Backups, monitoring, alerts included",
    ],
    price: "Coming soon",
    priceNote: "Plans announced once billing is live",
  },
  {
    n: "02",
    tag: "Self-hosted",
    title: "Your servers",
    lead:
      "Run the entire platform on machines you own. Any Linux box, any provider, any region. Add nodes as you grow.",
    points: [
      "Connect any VPS - Hetzner, DO, AWS, bare metal",
      "Multi-server fan-out across regions",
      "No agent or dashboard on your boxes",
    ],
    price: "Free & open-source",
    priceNote: "Apache-2.0 — self-host today, no billing",
    feature: true,
  },
  {
    n: "03",
    tag: "Hybrid",
    title: "Mix and match",
    lead:
      "Cloud for the burst, your servers for sensitive data. One control plane. Move workloads without rebuilding.",
    points: [
      "Apps on your servers, services on the cloud",
      "Or production locally, previews managed",
      "One billing, one team, one dashboard",
    ],
    price: "Coming soon",
    priceNote: "Available once plans open",
  },
];

export function DeploymentModels() {
  return (
    <section className="dm-section">
      <div className="dm-container">
        <header className="dm-head">
          <p className="dm-eyebrow">Where it runs</p>
          <h2 className="dm-title">
            Cloud, self-hosted,<br />or both.
          </h2>
          <p className="dm-sub">
            Same platform, three deployment shapes - and you can switch any day.
          </p>
        </header>

        <div className="dm-grid">
          {MODELS.map((m) => (
            <article
              key={m.n}
              className={`dm-panel ${m.feature ? "dm-panel--feature" : ""}`}
            >
              <div className="dm-panel-top">
                <span className="dm-panel-n">{m.n}</span>
                <span className="dm-panel-tag">{m.tag}</span>
              </div>

              <h3 className="dm-panel-title">{m.title}</h3>
              <p className="dm-panel-lead">{m.lead}</p>

              <ul className="dm-panel-points">
                {m.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>

              <div className="dm-panel-foot">
                <span className="dm-panel-price">{m.price}</span>
                <span className="dm-panel-pricenote">{m.priceNote}</span>
              </div>
            </article>
          ))}
        </div>

        {/* ── Migration callout ────────────────────────────────────── */}
        <div className="dm-migrate">
          <div className="dm-migrate-left">
            <span className="dm-migrate-tag">Migrate any day</span>
            <h3 className="dm-migrate-title">
              Cloud{" "}
              <span className="dm-migrate-arrow" aria-hidden="true">⇄</span>
              {" "}self-hosted.<br />
              <span className="dm-migrate-soft">One click, any time.</span>
            </h3>
          </div>
          <p className="dm-migrate-body">
            Your apps are plain containers and your services are standard images.
            Move workloads between Openship Cloud and your own servers without
            rebuilding, rewriting, or paying an exit tax. Click, confirm, done.
          </p>
        </div>
      </div>
    </section>
  );
}
