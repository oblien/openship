import { SectionHeader } from "./section-header";

/**
 * Open source - editorial spread. Claim and actions on the left, the licence
 * as a drenched plate on the right with the facts ruled underneath it.
 */
export function OpenSource({ index, total }: { index: number; total: number }) {
  return (
    <section className="lp-sec">
      <SectionHeader label="Open source" index={index} total={total} />

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="os-grid">
            <div className="os-lead">
              <h2 className="os-headline">
                Yours to&nbsp;run, fork,<br />and&nbsp;ship.
              </h2>
              <p className="os-body">
                The dashboard, the CLI, the agents, the infrastructure adapters -
                all public, all readable, all auditable. Run it on a Raspberry
                Pi or a fleet. Contribute back when you want to.
              </p>
              <div className="os-cta-row">
                <a
                  className="os-btn os-btn--primary"
                  href="https://github.com/oblien/openship"
                  target="_blank"
                  rel="noreferrer"
                >
                  Star on GitHub
                </a>
                <a
                  className="os-btn os-btn--ghost"
                  href="https://github.com/oblien/openship"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the source
                </a>
              </div>
            </div>

            <aside className="os-side">
              <div className="os-license" data-section="dark">
                <span className="os-license-eyebrow">Licensed under</span>
                <span className="os-license-name">Apache 2.0</span>
                <p className="os-license-note">
                  Permissive licensing. Yours to use, modify, and ship
                  anywhere - including in commercial and closed-source products.
                </p>
              </div>

              <dl className="os-meta">
                <div className="os-meta-row">
                  <dt>Runs on</dt>
                  <dd>Linux, macOS, Windows. ARM and x86. Any cloud or your laptop.</dd>
                </div>
                <div className="os-meta-row">
                  <dt>Telemetry</dt>
                  <dd>Off by default. Opt in if you want to help improve the platform.</dd>
                </div>
                <div className="os-meta-row">
                  <dt>Lock-in</dt>
                  <dd>Plain Docker containers and standard manifests. Leave any day.</dd>
                </div>
                <div className="os-meta-row">
                  <dt>Standards</dt>
                  <dd>Docker, OCI, Let&rsquo;s Encrypt, ACME, S3, SMTP.</dd>
                </div>
              </dl>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}
