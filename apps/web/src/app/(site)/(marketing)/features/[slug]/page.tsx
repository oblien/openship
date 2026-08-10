import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import { FEATURES, getFeature, relatedFeatures } from "../_data";
import { FeatureShot } from "../_components/FeatureShot";
import "../../roadmap/roadmap.css";
import "../features.css";

type Params = Promise<{ slug: string }>;

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const f = getFeature(slug);
  if (!f) return { title: "Feature — Openship" };
  const title = `${f.title} — Features`;
  return {
    title,
    description: f.summary,
    alternates: { canonical: `/features/${f.slug}` },
    openGraph: { title: `${f.title} — Openship`, description: f.summary, url: `/features/${f.slug}`, type: "article" },
    twitter: { card: "summary_large_image", title: `${f.title} — Openship`, description: f.summary },
  };
}

export default async function FeatureDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const feature = getFeature(slug);
  if (!feature) notFound();

  const Icon = feature.icon;
  const related = relatedFeatures(feature);

  return (
    <>
      <Navbar />

      <main className="relative">
        {/* ── HEADER ─────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pt-28 sm:pt-32">
          <Link href="/features" className="ft-back">
            <ArrowLeft className="size-3.5" />
            All features
          </Link>

          <div className="mt-8 grid items-center gap-10 md:grid-cols-2">
            <div>
              <span className="ft-detail-tag">{feature.category}</span>
              <div className="mt-5 flex items-center gap-3">
                <span className="ft-card-icon">
                  <Icon className="size-5" strokeWidth={1.6} />
                </span>
                <h1
                  className="text-[clamp(2rem,4.4vw,3rem)] font-medium leading-[1.06] tracking-[-0.025em]"
                  style={{ color: "var(--th-text-heading)" }}
                >
                  {feature.title}
                </h1>
              </div>
              <p className="mt-5 text-[17px] leading-[1.7]" style={{ color: "var(--th-text-body)" }}>
                {feature.summary}
              </p>
            </div>

            <FeatureShot src={feature.screenshot} alt={`${feature.title} in Openship`} Icon={Icon} priority />
          </div>
        </section>

        {/* ── BODY + HIGHLIGHTS ──────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-8 pt-16 sm:pt-20">
          <div className="grid gap-10 md:grid-cols-[1.4fr_1fr]">
            <div className="ft-detail-body">
              {feature.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            <div className="space-y-3">
              {feature.highlights.map((h) => (
                <div key={h.title} className="ft-highlight">
                  <div className="flex items-start gap-2.5">
                    <Check className="ft-check mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
                    <div>
                      <p className="ft-highlight-title">{h.title}</p>
                      <p className="ft-highlight-desc">{h.desc}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── RELATED ────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-8 pt-16">
          <h2 className="ft-cat-name mb-5">Explore more</h2>
          <div className="ft-grid">
            {related.map((f) => {
              const RIcon = f.icon;
              return (
                <Link key={f.slug} href={`/features/${f.slug}`} className="ft-card group">
                  <span className="ft-card-icon">
                    <RIcon className="size-5" strokeWidth={1.6} />
                  </span>
                  <h3 className="ft-card-title">{f.title}</h3>
                  <p className="ft-card-tagline">{f.tagline}</p>
                  <span className="ft-card-more">
                    Explore
                    <ArrowRight className="size-3.5" />
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        {/* ── CTA ────────────────────────────────────────────── */}
        <div className="section-divider mx-auto max-w-5xl" />
        <section className="mx-auto max-w-5xl px-6 pb-32 pt-24 text-center">
          <h2
            className="text-[clamp(1.9rem,3.8vw,2.6rem)] font-medium leading-[1.08] tracking-[-0.025em]"
            style={{ color: "var(--th-text-heading)" }}
          >
            Ship it your way.
          </h2>
          <p className="mx-auto mt-5 max-w-md text-[16px] leading-[1.6]" style={{ color: "var(--th-text-body)" }}>
            Self-hosted and free, or managed on Openship Cloud — the same workflow either way.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
            <Link href="/download" className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium">
              Get started
              <ArrowRight className="ml-1.5 -mr-1 size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/docs" className="th-btn-ghost group rounded-full px-7 py-3 text-[15px] font-medium">
              Read the docs
            </Link>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
