import { SectionHeader } from "./section-header";

/**
 * Mail server spotlight - claim and actions on one line, the product shot
 * full-bleed between the rails, then the argument as a rail of cards.
 *
 * The lead card is the only drenched surface in the section and carries the
 * paragraph plus the authentication chain it sets up, because that is the
 * claim; the three cards after it are what backs the claim up. Reading order
 * and visual weight agree, which is what the old two-column split could not
 * do with a paragraph this long.
 */
export function MailServer({ index, total }: { index: number; total: number }) {
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
              <a href="/login" className="uc-cta uc-cta--primary">
                Get started
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
          <div className="uc-rail">
            <div className="uc-rail-row">
            <article className="uc-card uc-card--drenched" data-section="dark">
              <span className="uc-eyebrow">
                <span className="uc-eyebrow-dot" aria-hidden="true" />
                Auto-configured
              </span>

              <p className="uc-card-lead">
                A real mail server on your own box - not a send-only API. Outbound relays through a
                trusted provider (Amazon SES or any SMTP) so mail lands with a warmed, high-reputation
                IP, while every mailbox, message, and byte stays on your server. One click sets up the
                domains, certificates, and SPF/DKIM/DMARC chain.
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
    desc: 'SPF, DKIM, DMARC, reverse DNS - verified and configured for you.',
  },
  {
    name: 'Unlimited domains.',
    desc: 'Add as many sending domains as you need. No add-on, no per-domain pricing.',
  },
  {
    name: 'Open SMTP & REST API.',
    desc: 'Plug straight in from your code. Webhooks for opens, clicks, bounces.',
  },
];
