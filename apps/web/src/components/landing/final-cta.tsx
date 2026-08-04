/**
 * The page's sign-off. A plate that meets the rails, so the grid closes on
 * the same lines it opened on rather than on a floating card.
 *
 * The product shot sits at the bottom and runs off the plate's own edge
 * rather than being framed inside it. Cutting it there is what makes the
 * page feel like it continues past the fold instead of stopping dead on a
 * button, and it is why this shot lives here rather than under the hero.
 */
export function FinalCta() {
  return (
    <section className="lp-sec">
      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className="fcta-container" data-section="dark">
          <h2 className="fcta-title">
            Ready to ship?
          </h2>
          <p className="fcta-sub">
            Cloud or a server you own.<br />
            No lock-in, no configuration files.
          </p>
          <div className="fcta-row">
            <a href="/login" className="fcta-btn fcta-btn--primary">
              Get started
            </a>
            <a
              href="https://github.com/oblien/openship"
              target="_blank"
              rel="noreferrer"
              className="fcta-btn fcta-btn--ghost"
            >
              View on GitHub
            </a>
          </div>
          <ul className="fcta-trust">
            <li>CLI, web &amp; desktop</li>
            <li>Cloud or self-hosted</li>
            <li>No lock-in</li>
            <li>Open source</li>
          </ul>

          <figure className="fcta-shot win">
            <div className="win-bar">
              <span className="win-dot" aria-hidden="true" />
              <span className="win-dot" aria-hidden="true" />
              <span className="win-dot" aria-hidden="true" />
              <span className="win-title">openship — dashboard</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screen.png"
              alt="Openship dashboard"
              loading="lazy"
              decoding="async"
              width={2880}
              height={1800}
              className="win-img"
            />
          </figure>
          </div>
        </div>
      </div>
    </section>
  );
}
