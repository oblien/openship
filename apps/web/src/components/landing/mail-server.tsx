/**
 * Mail server spotlight - editorial copy on the left, dashboard preview on
 * the right. Layout is symmetric: the left column's heading + body + points +
 * stats and the right column's image + status row + CTAs balance to roughly
 * equal heights so the two columns center as a single composition.
 */
export function MailServer() {
  return (
    <section className="ms-section">
      <div className="ms-container">
        <div className="ms-grid">
          {/* Text side */}
          <div className="ms-lead">
            <p className="ms-eyebrow">Built-in mail server</p>
            <h2 className="ms-title">
              Transactional email,<br />
              <span className="ms-title-soft">unlimited domains.</span>
            </h2>
            <p className="ms-body">
              A real mail server on your own box - not a send-only API. Outbound relays through a
              trusted provider (Amazon SES or any SMTP) so mail lands with a warmed, high-reputation
              IP, while every mailbox, message, and byte stays on your server. One click sets up the
              domains, certificates, and SPF/DKIM/DMARC chain.
            </p>

            <ul className="ms-points">
              {POINTS.map((p, i) => (
                <li key={p.name}>
                  <span className="ms-point-num">{String(i + 1).padStart(2, '0')}</span>
                  <div className="ms-point-text">
                    <span className="ms-point-name">{p.name}</span>
                    <span className="ms-point-desc">{p.desc}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Image side - image + status row + CTAs */}
          <div className="ms-right">
            <figure className="ms-shot">
              <div className="ms-shot-frame">
                <span className="ms-shot-chrome" aria-hidden="true">
                  <span className="ms-shot-dot" />
                  <span className="ms-shot-dot" />
                  <span className="ms-shot-dot" />
                  <span className="ms-shot-chrome-live">
                    <span className="ms-shot-chrome-live-dot" />
                    Live · 247 sending
                  </span>
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/email-preview.png"
                  alt="Openship mail dashboard"
                  loading="lazy"
                  decoding="async"
                  width={1920}
                  height={1080}
                  className="ms-shot-img"
                />
              </div>
            </figure>

            {/* Status row - DNS records auto-configured */}
            <div className="ms-status-row">
              <div className="ms-status-head">
                <svg
                  className="ms-status-check"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="8" cy="8" r="7.25" stroke="currentColor" strokeWidth="1.4" />
                  <path
                    d="M4.5 8.25 L7 10.5 L11.5 5.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
                <span>Auto-configured</span>
              </div>
              <div className="ms-status-pills">
                <span className="ms-status-pill">SPF</span>
                <span className="ms-status-pill">DKIM</span>
                <span className="ms-status-pill">DMARC</span>
                <span className="ms-status-pill">TLS</span>
              </div>
            </div>

            <div className="ms-cta-row">
              <a href="/login" className="th-btn group rounded-full px-6 py-2.5 text-[14px] font-medium">
                Get started
                <svg
                  className="ml-1 -mr-1 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </a>
              <a href="/mail" className="th-btn-ghost group rounded-full px-6 py-2.5 text-[14px] font-medium">
                See more
                <svg
                  className="ml-1 -mr-1 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </a>
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
