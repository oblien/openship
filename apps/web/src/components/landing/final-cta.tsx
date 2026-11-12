import { useCopy } from "@/i18n/use-copy";

import { DarkSection } from "./dark-section";

export function FinalCta() {
  const copy = useCopy();

  return (
    <section className="fcta-outer">
      <DarkSection>
        <div className="fcta-container">
          <h2 className="fcta-title">{copy("Ready to ship?")}</h2>
          <p className="fcta-sub">
            {copy("Cloud or a server you own.")}
            <br />
            {copy("No lock-in, no configuration files.")}
          </p>
          <div className="fcta-row">
            <a href="/login" className="fcta-btn fcta-btn--primary">
              {copy("Get started")}
            </a>
            <a
              href="https://github.com/oblien/openship"
              target="_blank"
              rel="noreferrer"
              className="fcta-btn fcta-btn--ghost"
            >
              {copy("View on GitHub")}
            </a>
          </div>
          <ul className="fcta-trust">
            <li>{copy("CLI, web & desktop")}</li>
            <li>{copy("Cloud or self-hosted")}</li>
            <li>{copy("No lock-in")}</li>
            <li>{copy("Open source")}</li>
          </ul>
        </div>
      </DarkSection>
    </section>
  );
}
