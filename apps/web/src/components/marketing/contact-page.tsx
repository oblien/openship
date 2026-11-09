import type { ReactNode } from "react";
import { Navbar, Footer } from "@/components/landing";
import { ContactForm } from "@/components/contact-form";
import { IllustratedLink, type IllustratedLinkProps } from "./illustrated-link";
import { MarketingIntro } from "./marketing-intro";

/** Contact and support use the same form and page layout; source routing stays in ContactForm. */
export function ContactPage({
  source,
  eyebrow,
  title,
  description,
  links,
  children,
}: {
  source: "contact" | "support";
  eyebrow: string;
  title: ReactNode;
  description: string;
  links: IllustratedLinkProps[];
  children?: ReactNode;
}) {
  return (
    <>
      <Navbar />
      <main className="marketing-page">
        <MarketingIntro eyebrow={eyebrow} title={title} description={description} />
        <div className="site-container marketing-content">
          <div className="marketing-contact">
            <aside aria-label="Other ways to reach us">
              {links.map((link) => (
                <IllustratedLink key={link.title} {...link} heading="h2" />
              ))}
              {children}
            </aside>
            <section className="marketing-contact-form" aria-label="Send a request">
              <ContactForm source={source} />
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
