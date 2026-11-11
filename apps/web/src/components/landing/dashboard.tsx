/**
 * Hero showcase - center dashboard screenshot flanked by two
 * companion shots tilted behind it. Sits directly under the hero.
 */
export function Dashboard() {
  return (
    <section className="dashboard-showcase">
      <div className="site-container">
        <div className="dashboard-stack">
          {/* eslint-disable @next/next/no-img-element */}
          <div className="dashboard-stack__back dashboard-stack__back--left" aria-hidden="true">
            <img
              src="/mail-list.png"
              alt=""
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="dashboard-stack__back dashboard-stack__back--right" aria-hidden="true">
            <img
              src="/email-preview.png"
              alt=""
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="dashboard-stack__center">
            <img
              src="/screen.png"
              alt="Openship dashboard"
              loading="lazy"
              decoding="async"
              width="2880"
              height="1800"
            />
          </div>
          {/* eslint-enable @next/next/no-img-element */}
        </div>
      </div>
    </section>
  );
}
