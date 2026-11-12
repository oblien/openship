import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";

export function NotFoundContent() {
  const copy = useCopy();
  return (
    <>
      <Navbar />
      <main className="legal-root">
        <section className="legal-hero">
          <div className="legal-container" style={{ textAlign: "center" }}>
            <p className="legal-eyebrow">404</p>
            <h1 className="legal-title">{copy("Page not found.")}</h1>
            <p className="legal-meta" style={{ maxWidth: "460px", margin: "0 auto" }}>
              {copy("The page you’re looking for doesn’t exist or has moved.")}
            </p>
            <div style={{ marginTop: "32px" }}>
              <Link
                href="/"
                className="inline-block rounded-full px-6 py-2.5 text-[14px] font-medium transition-all"
                style={{ background: "var(--th-btn-bg)", color: "var(--th-btn-text)" }}
              >
                {copy("Back home")}
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
