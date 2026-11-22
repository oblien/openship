import type { ReactNode } from "react";
import { useCopy } from "@/i18n/use-copy";

import { DarkSection } from "./dark-section";

type LandingCtaProps = {
  title: string;
  description: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function LandingCtaSection({ title, description, actions, children, className = "" }: LandingCtaProps) {
  return (
    <section className={`fcta-outer ${className}`} aria-label={title}>
      <DarkSection>
        <div className="fcta-container">
          <h2 className="fcta-title">{title}</h2>
          <p className="fcta-sub">{description}</p>
          <div className="fcta-row">{actions}</div>
          {children}
        </div>
      </DarkSection>
    </section>
  );
}

export function FinalCta() {
  const copy = useCopy();
  return (
    <LandingCtaSection
      title={copy("Ready to ship?")}
      description={
        <>
          {copy("Cloud or a server you own.")}
          <br />
          {copy("No lock-in, no configuration files.")}
        </>
      }
      actions={
        <>
          <a href="/login" className="fcta-btn fcta-btn--primary">{copy("Get started")}</a>
          <a href="https://github.com/oblien/openship" target="_blank" rel="noreferrer" className="fcta-btn fcta-btn--ghost">
            {copy("View on GitHub")}
          </a>
        </>
      }
    >
      <ul className="fcta-trust">
        <li>{copy("CLI, web & desktop")}</li>
        <li>{copy("Cloud or self-hosted")}</li>
        <li>{copy("No lock-in")}</li>
        <li>{copy("Open source")}</li>
      </ul>
    </LandingCtaSection>
  );
}
