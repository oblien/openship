"use client";

import { useRef } from "react";
import { SectionHeader } from "./section-header";

/**
 * Mail server spotlight - claim and actions on one line, the product shot
 * full-bleed between the rails, then the argument as a rail of cards.
 *
 * The lead card carries the claim and authentication chain; the three cards
 * after it are the supporting proof.
 */
export function MailServer({ index, total }: { index: number; total: number }) {
  const railRef = useRef<HTMLDivElement>(null);

  const scrollCards = (direction: -1 | 1) => {
    const rail = railRef.current;
    const card = rail?.querySelector<HTMLElement>(".uc-card");
    if (!rail || !card) return;

    rail.scrollBy({
      left: direction * (card.offsetWidth + 20),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  return (
    <section className="lp-sec">
      <SectionHeader label="Built-in mail server" index={index} total={total} />

      <div className="lp-band">
        <div className="lp-band-in">
          <div className="uc-headline">
            <h2 className="uc-headline-title">
              Transactional email,<br />
              <span className="uc-headline-soft">unlimited domains.</span>
            </h2>

            <div className="uc-cta-cluster">
              <a href="/mail" className="uc-cta">
                See more
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <figure className="win">
            <div className="win-bar">
              <span className="win-dot" aria-hidden="true" />
              <span className="win-dot" aria-hidden="true" />
              <span className="win-dot" aria-hidden="true" />
              <span className="win-status">
                <span className="win-status-dot" aria-hidden="true" />
                Live &middot; 247 sending
              </span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/email-preview.png"
              alt="Openship mail dashboard"
              loading="lazy"
              decoding="async"
              width={1920}
              height={1080}
              className="win-img"
            />
          </figure>
        </div>
      </div>

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="uc-rail-toolbar">
            <span className="uc-rail-label">Mail capabilities</span>
            <div className="uc-rail-nav">
              <button
                type="button"
                className="uc-rail-control"
                aria-label="Previous mail capability"
                aria-controls="mail-capabilities"
                onClick={() => scrollCards(-1)}
              >
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M11 7H3m0 0 3.5-3.5M3 7l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </button>
              <button
                type="button"
                className="uc-rail-control"
                aria-label="Next mail capability"
                aria-controls="mail-capabilities"
                onClick={() => scrollCards(1)}
              >
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </button>
            </div>
          </div>
          <div id="mail-capabilities" className="uc-rail" ref={railRef}>
            <div className="uc-rail-row">
              <article className="uc-card uc-card--featured">
                <span className="uc-eyebrow">
                  <span className="uc-eyebrow-dot" aria-hidden="true" />
                  Auto-configured
                </span>

                <h3 className="uc-card-title">Mail that belongs to you.</h3>
                <p className="uc-card-lead">
                  Run a real mail server on your own box. A trusted outbound relay keeps delivery
                  reliable while every mailbox, message, and byte stays on your server.
                </p>

                <div className="uc-card-foot">
                  <span className="uc-card-foot-label">Verified for you</span>
                  <div className="uc-pills">
                    <span className="uc-pill">SPF</span>
                    <span className="uc-pill">DKIM</span>
                    <span className="uc-pill">DMARC</span>
                    <span className="uc-pill">TLS</span>
                  </div>
                </div>
              </article>

              {POINTS.map((p, i) => (
                <article key={p.name} className="uc-card">
                  <span className="uc-eyebrow">
                    <span className="uc-eyebrow-dot" aria-hidden="true" />
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="uc-card-title">{p.name}</h3>
                  <p className="uc-card-desc">{p.desc}</p>
                  <div className="uc-card-foot">
                    <span className="uc-card-foot-label">{p.detail}</span>
                    <div className="uc-pills">
                      {p.tags.map((tag) => (
                        <span key={tag} className="uc-pill">{tag}</span>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const POINTS = [
  {
    name: 'One-click setup.',
    desc: 'SPF, DKIM, DMARC and reverse DNS are configured, verified and kept in sync from one setup flow.',
    detail: 'Configured automatically',
    tags: ['SPF', 'DKIM', 'DMARC', 'rDNS'],
  },
  {
    name: 'Unlimited domains.',
    desc: 'Add as many sending domains as you need, with separate identities and no add-on or per-domain pricing.',
    detail: 'Pricing stays flat',
    tags: ['No caps', 'No add-ons', 'No domain fee'],
  },
  {
    name: 'Open SMTP & REST API.',
    desc: 'Send through standard SMTP or REST, then receive webhooks for deliveries, opens, clicks and bounces.',
    detail: 'Works with your stack',
    tags: ['SMTP', 'REST', 'Webhooks'],
  },
];
