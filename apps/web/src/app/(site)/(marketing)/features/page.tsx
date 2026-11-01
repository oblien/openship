import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { FEATURES, CATEGORY_ORDER, CATEGORY_BLURB, categoryId } from "./_data";
import "./features.css";

const PAGE_TITLE = "Features";
const PAGE_DESCRIPTION =
  "Explore Openship's deployment, CI, runners, apps, backups, migration, networking, monitoring, and team access features, with detailed guides and availability.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/features" },
  openGraph: {
    title: `${PAGE_TITLE} — Openship`,
    description: PAGE_DESCRIPTION,
    url: "/features",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} — Openship`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

export default function FeaturesPage() {
  return (
    <>
      <Navbar />

      {/* ── HERO ─────────────────────────────────────────────── */}
      <section className="ft-hero hero-section relative flex min-h-[60dvh] flex-col items-center justify-center overflow-hidden">
        <div className="hero-grain absolute inset-0" aria-hidden="true" />
        <div className="hero-grid absolute inset-0" aria-hidden="true" />
        <div className="hero-aurora" aria-hidden="true">
          <div className="hero-aurora-core" />
          <div className="hero-aurora-wing hero-aurora-wing--left" />
          <div className="hero-aurora-wing hero-aurora-wing--right" />
        </div>

        <div className="relative z-20 mx-auto w-full max-w-[820px] px-6 text-center">
          <p className="animate-fade-in-up text-[12px] font-semibold uppercase tracking-[0.16em] th-text-muted">
            Features
          </p>
          <h1 className="animate-fade-in-up animate-delay-100 mt-5">
            <span className="block text-[clamp(2.4rem,5.2vw,4rem)] font-medium leading-[1.08] tracking-[-0.02em] th-text-heading">
              Everything between your
            </span>
            <span className="hero-headline-second block text-[clamp(2.4rem,5.2vw,4rem)] font-light italic leading-[1.08] tracking-[-0.015em]">
              code and production.
            </span>
          </h1>
          <p className="animate-fade-in-up animate-delay-200 mx-auto mt-6 max-w-[560px] text-[16px] leading-[1.65] th-text-body">
            From the first build to CI, data recovery, and team access. Explore {FEATURES.length}{" "}
            capabilities, see how they work, and find the guide for your setup.
          </p>
        </div>

        <div className="hero-edge-fade-top absolute top-0 left-0 right-0 h-20" aria-hidden="true" />
        <div
          className="hero-edge-fade-bottom absolute bottom-0 left-0 right-0 h-40"
          aria-hidden="true"
        />
      </section>

      {/* ── CATALOG ──────────────────────────────────────────── */}
      <main className="relative">
        <div className="mx-auto max-w-6xl px-6 pb-24 pt-16 sm:pt-20">
          <nav className="ft-category-nav" aria-label="Feature categories">
            {CATEGORY_ORDER.map((category) => (
              <Link key={category} href={`#${categoryId(category)}`}>
                {category}{" "}
                <span>{FEATURES.filter((feature) => feature.category === category).length}</span>
              </Link>
            ))}
          </nav>
          {CATEGORY_ORDER.map((category) => {
            const items = FEATURES.filter((f) => f.category === category);
            if (items.length === 0) return null;
            return (
              <section key={category} id={categoryId(category)} className="ft-cat">
                <div className="ft-cat-head">
                  <h2 className="ft-cat-name">{category}</h2>
                  <span className="ft-cat-blurb">{CATEGORY_BLURB[category]}</span>
                </div>
                <div className="ft-grid">
                  {items.map((f) => {
                    const Icon = f.icon;
                    return (
                      <Link key={f.slug} href={`/features/${f.slug}`} className="ft-card group">
                        <span className="ft-card-icon">
                          <Icon className="size-5" strokeWidth={1.6} />
                        </span>
                        <h3 className="ft-card-title">{f.title}</h3>
                        <p className="ft-card-tagline">{f.tagline}</p>
                        {f.availability && (
                          <span className="ft-card-availability">Availability details inside</span>
                        )}
                        <span className="ft-card-more">
                          Explore
                          <ArrowRight className="size-3.5" />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        {/* ── CTA ────────────────────────────────────────────── */}
        <div className="section-divider mx-auto max-w-5xl" />
        <section className="mx-auto max-w-5xl px-6 pb-32 pt-24 text-center">
          <h2
            className="text-[clamp(2rem,4vw,2.75rem)] font-medium leading-[1.08] tracking-[-0.025em]"
            style={{ color: "var(--th-text-heading)" }}
          >
            Deploy your first app in minutes.
          </h2>
          <p
            className="mx-auto mt-5 max-w-md text-[16px] leading-[1.6]"
            style={{ color: "var(--th-text-body)" }}
          >
            Self-hosted and free, or managed on Openship Cloud. Same workflow either way.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
            <Link
              href="/download"
              className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
            >
              Get started
              <ArrowRight className="ml-1.5 -mr-1 size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/docs"
              className="th-btn-ghost group rounded-full px-7 py-3 text-[15px] font-medium"
            >
              Read the docs
            </Link>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
