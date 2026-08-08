import { SectionHeader } from "./section-header";

/**
 * Deployment models - the same platform in three shapes.
 *
 * Laid out as three cells of the ruled grid rather than three floating
 * panels: they are alternatives, so they get identical frames and differ
 * only in what they say. The migration callout closes the section, because
 * "you can switch any day" is only reassuring once you know the choices.
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

export function DeploymentModels({ index, total }: { index: number; total: number }) {
  return (
    <section className="lp-sec">
      <SectionHeader label="Where it runs" index={index} total={total} />

      <div className="lp-band">
        <div className="lp-band-in">
          <div className="dm-headline">
            <h2 className="dm-headline-title">
              Cloud, self-hosted,<br />or both.
            </h2>
            <p className="dm-headline-sub">
              Same platform, three deployment shapes - and you can switch any day.
            </p>
          </div>
        </div>
      </div>

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="dm-grid">
            {MODELS.map((m) => (
              <article
                key={m.n}
                className="dm-cell"
                data-feature={m.feature ? "true" : undefined}
              >
                <span className="dm-cell-eyebrow">
                  {m.n} / {m.tag}
                </span>
                <h3 className="dm-cell-title">{m.title}</h3>
                <p className="dm-cell-lead">{m.lead}</p>

                <ul className="dm-cell-points">
                  {m.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>

                <div className="dm-cell-foot">
                  <span className="dm-cell-price">{m.price}</span>
                  <span className="dm-cell-pricenote">{m.priceNote}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>

      {/* ── Migration callout ────────────────────────────────────── */}
      <div className="lp-band">
        <div className="lp-band-in">
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
      </div>
    </section>
  );
}
