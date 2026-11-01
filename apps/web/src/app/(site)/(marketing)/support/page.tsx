import type { Metadata } from "next";
import { BRAND_LINKS, CLOUD_DASHBOARD_URL, SUPPORT_EMAIL } from "@repo/core";
import { Navbar, Footer } from "@/components/landing";
import { ContactForm } from "@/components/contact-form";

export const metadata: Metadata = {
  title: "Support",
  description: "Get help with Openship Cloud, deployments, your account, or billing.",
  alternates: { canonical: "/support" },
};

export default function SupportPage() {
  return (
    <>
      <Navbar />
      <main className="legal-root">
        <section className="legal-hero">
          <div className="legal-container">
            <p className="legal-eyebrow">Openship Support</p>
            <h1 className="legal-title">
              Let&rsquo;s get you unstuck.
              <br />
              <span className="legal-title-soft">Talk to our team.</span>
            </h1>
            <p className="legal-meta">
              Get help with a deployment, your Cloud account, or billing. You can send a request
              here even if you can&rsquo;t sign in.
            </p>
          </div>
        </section>
        <section className="legal-body">
          <div className="legal-container">
            <div className="legal-grid">
              <aside className="legal-toc" aria-label="Support links">
                <p className="legal-toc-title">Here to help</p>
                <ol>
                  <li>
                    <a href={`${CLOUD_DASHBOARD_URL}/support`}>
                      <span className="legal-toc-n">01</span>My Cloud tickets
                    </a>
                  </li>
                  <li>
                    <a href={`mailto:${SUPPORT_EMAIL}`}>
                      <span className="legal-toc-n">02</span>
                      {SUPPORT_EMAIL}
                    </a>
                  </li>
                  <li>
                    <a href={BRAND_LINKS.docs}>
                      <span className="legal-toc-n">03</span>Documentation
                    </a>
                  </li>
                  <li>
                    <a href={BRAND_LINKS.community} target="_blank" rel="noreferrer">
                      <span className="legal-toc-n">04</span>Community
                    </a>
                  </li>
                </ol>
              </aside>
              <article className="legal-article">
                <section className="legal-section" style={{ borderBottom: "none" }}>
                  <ContactForm source="support" />
                </section>
              </article>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
