import type { Metadata } from "next";
import { Navbar, Footer } from "@/components/landing";
import { ContactForm } from "@/components/contact-form";

const PAGE_TITLE = "Contact Us";
const PAGE_DESCRIPTION =
  "Get in touch with the Openship team. Send us a message and we'll get back to you as soon as possible.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/contact" },
  openGraph: {
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
    url: "/contact",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
  },
};

export default function ContactPage() {
  return (
    <>
      <Navbar />
      <main className="legal-root">
        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">Contact Us</p>
            <h1 className="legal-title">
              We&rsquo;re here to help.<br />
              <span className="legal-title-soft">Send us a message.</span>
            </h1>
            <p className="legal-meta">
              Fill out the form below and we&rsquo;ll reply within 24 hours.
            </p>
          </div>
        </section>

        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              <aside className="legal-toc" aria-label="Contact info">
                <p className="legal-toc-title">Contact info</p>
                <ol>
                  <li>
                    <a href="mailto:support@oblien.com">
                      <span className="legal-toc-n">01</span>
                      Support
                    </a>
                  </li>
                  <li>
                    <a href="https://github.com/oblien/openship/issues" target="_blank" rel="noreferrer">
                      <span className="legal-toc-n">02</span>
                      GitHub issues
                    </a>
                  </li>
                  <li>
                    <a href="mailto:security@oblien.com">
                      <span className="legal-toc-n">03</span>
                      Security
                    </a>
                  </li>
                  <li>
                    <a href="mailto:privacy@openship.io">
                      <span className="legal-toc-n">04</span>
                      Privacy
                    </a>
                  </li>
                  <li>
                    <a href="mailto:legal@openship.io">
                      <span className="legal-toc-n">05</span>
                      Legal
                    </a>
                  </li>
                </ol>
              </aside>

              <article className="legal-article">
                <section className="legal-section" style={{ borderBottom: "none" }}>
                  <ContactForm />
                </section>

                <footer className="legal-foot">
                  <p>
                    Prefer the docs? Read the <a href="/docs">documentation</a> or{" "}
                    <a href="/trust">Trust &amp; Security</a>.
                  </p>
                </footer>
              </article>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
