import { getCopy } from "@/i18n/copy-server";
import type { ReactNode } from "react";
import { Navbar, Footer } from "@/components/landing";
import { ContactForm } from "@/components/contact-form";
import { IllustratedLink, type IllustratedLinkProps } from "./illustrated-link";
import { MarketingIntro } from "./marketing-intro";
import { connection } from "next/server";

/** Public contact layout. Customer support starts in the signed-in dashboard. */
export async function ContactPage({
  eyebrow,
  title,
  description,
  links,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description: string;
  links: IllustratedLinkProps[];
  children?: ReactNode;
}) {
  const copy = await getCopy();

  await connection();
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro eyebrow={eyebrow} title={copy(title)} description={copy(description)} />
        <div className="site-container marketing-content">
          <div className="marketing-contact">
            <aside aria-label={copy("Other ways to reach us")}>
              {links.map((link) => (
                <IllustratedLink key={link.title} {...link} heading="h2" />
              ))}
              {children}
            </aside>
            <section className="marketing-contact-form" aria-label={copy("Send a request")}>
              <ContactForm siteKey={process.env.CONTACT_TURNSTILE_SITE_KEY ?? ""} />
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
