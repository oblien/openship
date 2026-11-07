import { Navbar, Footer } from "@/components/landing";
import { cloudFrom, getCloudPricing } from "@/lib/pricing";
import { cloudPlanHref } from "@/lib/cloud-links";
import { SituationPicker } from "./_components/situation-picker";
import { FIT_NO, FIT_YES, STEPS, compareRows, faq, situations, type Mark } from "./_data";
import "./migrate.css";

// Match the pricing page: the starting price comes from the live Cloud catalog.
export const revalidate = 60;

const MARK_LABEL: Record<Mark, string> = {
  strong: "Strong",
  limited: "Works, with limits",
  weak: "Weak spot",
};
const MARK_GLYPH: Record<Mark, string> = { strong: "✓", limited: "–", weak: "✕" };

function MarkIcon({ mark }: { mark: Mark }) {
  return (
    <span className={`mg-m mg-m--${mark}`} role="img" aria-label={MARK_LABEL[mark]}>
      {MARK_GLYPH[mark]}
    </span>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2l2.3 2.3 4.7-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default async function MigratePage() {
  const pricing = await getCloudPricing();
  const from = cloudFrom(pricing);
  const cloudHref = cloudPlanHref();
  const rows = compareRows(from);
  const columns = [
    { key: "serverless", name: "Serverless hosting", note: "Pay per request, per seat" },
    { key: "edge", name: "Edge functions", note: "Small isolates, very cheap" },
  ] as const;

  return (
    <>
      <Navbar />
      <main className="mg">
        {/* ── HERO ─────────────────────────────────────────────── */}
        <section className="mg-hero">
          <div className="mg-aurora" aria-hidden="true" />
          <div className="mg-wrap">
            <p className="mg-chip">
              <span className="mg-chip-dot" aria-hidden="true" />
              Moving your app?
            </p>
            <h1 className="mg-h1">
              Keep your app.
              <span>Lose the workarounds.</span>
            </h1>
            <p className="mg-lead mg-lead--hero">
              Hosting bill growing with your traffic? App hitting memory limits, or split across
              three services? Openship Cloud runs your whole app as it is, on a server with fixed
              resources. Your frontend, API, workers and database, together.
            </p>
            <div className="mg-ctas">
              <a className="mg-btn mg-btn--dark" href={cloudHref}>
                Start on Cloud
                {from && <small>from {from}/mo</small>}
              </a>
              <a className="mg-btn mg-btn--ghost" href="#situations">
                Find your situation <span aria-hidden="true">↓</span>
              </a>
            </div>
            <dl className="mg-trust">
              <div>
                <dt>GitHub stars</dt>
                <dd>15K+</dd>
              </div>
              <div>
                <dt>fully open source</dt>
                <dd>Apache 2.0</dd>
              </div>
              {from && (
                <div>
                  <dt>a month to start on Cloud</dt>
                  <dd>{from}</dd>
                </div>
              )}
            </dl>
            <p className="mg-trust-note">
              Every line of the platform is public.{" "}
              <a
                href="https://github.com/oblien/openship"
                target="_blank"
                rel="noopener noreferrer"
              >
                Read the source on GitHub
              </a>
              .
            </p>
          </div>
        </section>

        {/* ── SITUATIONS ───────────────────────────────────────── */}
        <section className="mg-section" id="situations">
          <div className="mg-wrap">
            <header className="mg-head">
              <p className="mg-eyebrow">Sound familiar?</p>
              <h2 className="mg-h2">
                Pick what’s hurting.
                <br />
                <span>Here’s how it changes.</span>
              </h2>
              <p className="mg-lead">
                Most teams don’t move because they want to. They move because something broke,
                slowed them down or cost too much.
              </p>
            </header>
            <SituationPicker items={situations(from)} />
          </div>
        </section>

        {/* ── WHY ONE SERVER ───────────────────────────────────── */}
        <section className="mg-section mg-section--tight">
          <div className="mg-wrap">
            <div className="mg-dark" data-section="dark">
              <header className="mg-head">
                <p className="mg-eyebrow">Why this works</p>
                <h2 className="mg-h2">
                  Most of these problems come from one design.
                  <br />
                  <span>Openship uses a different one.</span>
                </h2>
                <p className="mg-lead">
                  Pay-per-request hosting is great for small sites and short requests. Real apps
                  need memory, long tasks and a database close by, and that model charges for each
                  one or doesn’t allow it.
                </p>
              </header>
              <div className="mg-models">
                <div className="mg-model">
                  <span className="mg-model-lbl">Pay-per-request hosting</span>
                  <h3>Many small pieces, billed one by one</h3>
                  <div className="mg-boxes">
                    {["function", "function", "edge", "other host: API", "other host: DB"].map(
                      (b, i) => (
                        <span key={i} className="mg-box">
                          {b}
                        </span>
                      ),
                    )}
                  </div>
                  <ul>
                    <li>Every request, second and GB is metered</li>
                    <li>Memory and time caps on each piece</li>
                    <li>Backend and database often live elsewhere</li>
                  </ul>
                </div>
                <div className="mg-model mg-model--os">
                  <span className="mg-model-lbl">Openship Cloud</span>
                  <h3>One server. Your whole app on it.</h3>
                  <div className="mg-boxes">
                    {["app", "worker", "postgres", "redis", "cron"].map((b) => (
                      <span key={b} className="mg-box mg-box--os">
                        {b}
                      </span>
                    ))}
                  </div>
                  <ul>
                    <li>Fixed CPU, RAM and storage for a fixed base price</li>
                    <li>Full runtime, no per-request caps</li>
                    <li>Everything on one private network</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── COMPARE (categories, no vendor names) ────────────── */}
        <section className="mg-section" id="compare">
          <div className="mg-wrap">
            <header className="mg-head">
              <p className="mg-eyebrow">Side by side</p>
              <h2 className="mg-h2">
                How it compares to the usual setups.
                <br />
                <span>Including where it doesn’t win.</span>
              </h2>
            </header>
            <div className="mg-cmp">
              <table>
                <thead>
                  <tr>
                    <th className="mg-cmp-kh" scope="col">
                      What matters
                    </th>
                    {columns.map((c) => (
                      <th key={c.key} scope="col">
                        <span className="mg-cmp-ch">{c.name}</span>
                        <small>{c.note}</small>
                      </th>
                    ))}
                    <th scope="col" className="mg-cmp-os">
                      <span className="mg-cmp-best">Best for real apps</span>
                      <span className="mg-cmp-ch">Openship Cloud</span>
                      <small>One managed server</small>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row" className="mg-cmp-k">
                        {row.label}
                      </th>
                      {columns.map((c) => (
                        <td key={c.key} data-label={c.name}>
                          <MarkIcon mark={row[c.key][0]} />
                          <span className="mg-cmp-t">
                            {row[c.key][1]}
                            {row.tag?.[c.key] && (
                              <span className="mg-cmp-tag">{row.tag[c.key]}</span>
                            )}
                          </span>
                        </td>
                      ))}
                      <td className="mg-cmp-os" data-label="Openship Cloud">
                        <MarkIcon mark={row.openship[0]} />
                        <span className="mg-cmp-t">
                          {row.openship[1]}
                          {row.tag?.openship && (
                            <span className="mg-cmp-tag">{row.tag.openship}</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mg-cmp-legend">
              {(Object.keys(MARK_LABEL) as Mark[]).map((m) => (
                <span key={m}>
                  <span className={`mg-m mg-m--${m}`} aria-hidden="true">
                    {MARK_GLYPH[m]}
                  </span>
                  {MARK_LABEL[m]}
                </span>
              ))}
            </div>
            <p className="mg-cmp-note">
              General categories, not any one provider. Limits differ by provider and plan, so check
              yours.
            </p>
          </div>
        </section>

        {/* ── HONEST FIT ───────────────────────────────────────── */}
        <section className="mg-section mg-section--tight">
          <div className="mg-wrap">
            <header className="mg-head">
              <p className="mg-eyebrow">Is it right for you?</p>
              <h2 className="mg-h2">We’d rather tell you now.</h2>
            </header>
            <div className="mg-fit">
              <div className="mg-fitcard mg-fitcard--yes">
                <h3>Openship Cloud is a great fit if</h3>
                <ul>
                  {FIT_YES.map((t) => (
                    <li key={t}>
                      <span className="mg-ic mg-ic--ok">
                        <Check />
                      </span>
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mg-fitcard">
                <h3>You may not need to move if</h3>
                <ul>
                  {FIT_NO.map((t) => (
                    <li key={t}>
                      <span className="mg-ic mg-ic--x">
                        <Cross />
                      </span>
                      {t}
                    </li>
                  ))}
                </ul>
                <p className="mg-fit-note">
                  If that’s you, stay where you are. Come back when your app grows.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── STEPS ────────────────────────────────────────────── */}
        <section className="mg-section mg-section--tight">
          <div className="mg-wrap">
            <header className="mg-head">
              <p className="mg-eyebrow">How to move</p>
              <h2 className="mg-h2">
                Move in an afternoon.
                <br />
                <span>Not a quarter.</span>
              </h2>
            </header>
            <ol className="mg-steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className="mg-step">
                  <span className="mg-step-n">{i + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── HELP ─────────────────────────────────────────────── */}
        <section className="mg-section mg-section--tight" id="help">
          <div className="mg-wrap">
            <div className="mg-help">
              <div className="mg-help-l">
                <p className="mg-eyebrow">Not sure where to start?</p>
                <h2 className="mg-h2 mg-h2--sm">
                  Tell us what you run.
                  <br />
                  <span>We’ll help you move it.</span>
                </h2>
                <p className="mg-lead">
                  Send us your stack and what’s hurting. Someone from the Openship team replies with
                  a plan for your app.
                </p>
                <div className="mg-ctas mg-ctas--left">
                  <a className="mg-btn mg-btn--dark" href="/support">
                    Get help moving <span aria-hidden="true">→</span>
                  </a>
                  <a className="mg-btn mg-btn--ghost" href={cloudHref}>
                    Start on my own
                  </a>
                </div>
              </div>
              <div className="mg-help-r">
                <h3>What happens next</h3>
                <ol>
                  <li>
                    <b>You tell us your stack</b>
                    Framework, database, background jobs, current monthly bill.
                  </li>
                  <li>
                    <b>We suggest a plan and a server size</b>
                    So you pay for what your app needs, and no more.
                  </li>
                  <li>
                    <b>We help with the move</b>
                    Env vars, domain and database, step by step.
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* ── OPEN SOURCE ──────────────────────────────────────── */}
        <section className="mg-section mg-section--tight">
          <div className="mg-wrap">
            <header className="mg-head">
              <p className="mg-eyebrow">Built in the open</p>
              <h2 className="mg-h2">Trust what you can read.</h2>
              <p className="mg-lead">
                Openship Cloud runs the same open-source platform anyone can inspect, run and fork.
                No black box between you and your app.
              </p>
            </header>
            <div className="mg-oss">
              <div className="mg-osscard">
                <span className="mg-big">15K+</span>
                <p>Developers have starred Openship on GitHub.</p>
                <a
                  href="https://github.com/oblien/openship"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Star on GitHub →
                </a>
              </div>
              <div className="mg-osscard">
                <span className="mg-big">Apache 2.0</span>
                <p>
                  Permissive license. Self-host for free any day, even after you start on Cloud.
                </p>
                <a href="/docs/getting-started/quickstart">Self-host guide →</a>
              </div>
            </div>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────── */}
        <section className="mg-section mg-section--tight" id="faq">
          <div className="mg-wrap mg-narrow">
            <header className="mg-head">
              <p className="mg-eyebrow">Questions</p>
              <h2 className="mg-h2">Straight answers.</h2>
            </header>
            <div className="mg-faq">
              {faq(from).map((item) => (
                <details key={item.q}>
                  <summary>
                    <span>{item.q}</span>
                    <span className="mg-faq-pm" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────── */}
        <section className="mg-section mg-section--tight mg-final">
          <div className="mg-wrap">
            <div className="mg-dark" data-section="dark">
              <p className="mg-eyebrow">Ready when you are</p>
              <h2 className="mg-h2">
                Bring the app you already have.
                <br />
                <span>We’ll run it as it is.</span>
              </h2>
              <div className="mg-ctas">
                <a className="mg-btn mg-btn--light" href={cloudHref}>
                  Start on Cloud{from ? ` · from ${from}/mo` : ""} <span aria-hidden="true">→</span>
                </a>
                <a className="mg-btn mg-btn--ghost-dark" href="#help">
                  Get help moving
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
