import { useCopy } from "@/i18n/use-copy";

/**
 * Open source - editorial magazine spread. Big headline left, Apache 2.0
 * design moment + meta data right. No card grid, no install terminal.
 */
export function OpenSource() {
  const copy = useCopy();

  return (
    <section className="os-section">
      <div className="site-container os-container">
        <div className="os-grid">
          {/* Left - editorial */}
          <div className="os-lead">
            <p className="os-eyebrow">{copy("Open source")}</p>
            <h2 className="os-headline">
              {copy("Yours to run, fork,")}
              <br />
              {copy("and ship.")}
            </h2>
            <p className="os-body">
              {copy(
                "The dashboard, the CLI, the agents, the infrastructure adapters - all public, all readable, all auditable. Run it on a Raspberry Pi or a fleet. Contribute back when you want to.",
              )}
            </p>
            <div className="os-cta-row">
              <a
                className="os-btn os-btn--primary"
                href="https://github.com/oblien/openship"
                target="_blank"
                rel="noreferrer"
              >
                {copy("Star on GitHub")}
              </a>
              <a
                className="os-btn os-btn--ghost"
                href="https://github.com/oblien/openship"
                target="_blank"
                rel="noreferrer"
              >
                {copy("Read the source")}
              </a>
            </div>
          </div>

          {/* Right - Apache 2.0 design moment + meta */}
          <aside className="os-side">
            <div className="os-license">
              <span className="os-license-eyebrow">{copy("Licensed under")}</span>
              <span className="os-license-name">Apache 2.0</span>
              <p className="os-license-note">
                {copy(
                  "Permissive licensing. Yours to use, modify, and ship anywhere - including in commercial and closed-source products.",
                )}
              </p>
            </div>

            <dl className="os-meta">
              <div className="os-meta-row">
                <dt>{copy("Runs on")}</dt>
                <dd>{copy("Linux, macOS, Windows. ARM and x86. Any cloud or your laptop.")}</dd>
              </div>
              <div className="os-meta-row">
                <dt>{copy("Telemetry")}</dt>
                <dd>{copy("Off by default. Opt in if you want to help improve the platform.")}</dd>
              </div>
              <div className="os-meta-row">
                <dt>{copy("Lock-in")}</dt>
                <dd>{copy("Plain Docker containers and standard manifests. Leave any day.")}</dd>
              </div>
              <div className="os-meta-row">
                <dt>{copy("Standards")}</dt>
                <dd>{copy("Docker, OCI, Let’s Encrypt, ACME, S3, SMTP.")}</dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    </section>
  );
}
