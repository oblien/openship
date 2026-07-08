import Link from "next/link";
import type { Metadata } from "next";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import {
  Database,
  ShieldCheck,
  Split,
  KeyRound,
  Server,
  Github,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Trust & Security – Openship",
  description:
    "How Openship handles your data, permissions, and the boundary between self-hosted instances and Openship Cloud.",
};

type Pillar = {
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
};

const PILLARS: Pillar[] = [
  {
    title: "Data ownership",
    desc: "Local and server projects live only in your instance's database. Cloud projects are canonical on Openship Cloud. A resource is either fully local or fully cloud — never split.",
    icon: Database,
    href: "/docs/architecture/data-ownership",
  },
  {
    title: "Permission model",
    desc: "Every request passes one permission plane — role + resource grants. Denied access returns 404, never confirming a resource you can't see.",
    icon: ShieldCheck,
    href: "/docs/security/permissions",
  },
  {
    title: "Local ↔ cloud boundary",
    desc: "One gateway, one owner identity. Proxied requests forward no local cookies or org ids, and there are no hybrids — a local bug can't reach cloud-owned data.",
    icon: Split,
    href: "/docs/security/cloud-boundary",
  },
  {
    title: "Credential custody",
    desc: "The GitHub App key lives only on Openship Cloud; self-hosted instances mint tokens through it. Cloud sessions and secrets are encrypted at rest and never exposed to the browser.",
    icon: KeyRound,
    href: "/docs/security/auth",
  },
  {
    title: "Self-host or cloud",
    desc: "Run Openship entirely on your own infrastructure with no data leaving your network, or connect Openship Cloud when you want managed compute. Your choice, per project.",
    icon: Server,
    href: "/docs/architecture/overview",
  },
  {
    title: "Open source & auditable",
    desc: "Openship is open source under AGPL-3. The security boundary, permission plane, and gateway are all in the open for you to review.",
    icon: Github,
    href: "https://github.com/oblien/openship",
  },
];

export default function TrustPage() {
  return (
    <>
      <Navbar />
      <main className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px]"
          style={{
            background:
              "radial-gradient(55% 75% at 50% -10%, var(--th-aurora-violet-mid), transparent 70%)," +
              "radial-gradient(40% 60% at 82% 0%, var(--th-aurora-lavender), transparent 70%)",
          }}
        />

        <section className="mx-auto max-w-6xl px-6 pb-16 pt-28 sm:pt-32">
          <div className="max-w-2xl">
            <span className="th-text-secondary text-[13px] font-medium uppercase tracking-[0.14em]">
              Trust &amp; Security
            </span>
            <h1 className="th-text-heading mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
              Built to be trusted with production
            </h1>
            <p className="th-text-body mt-5 max-w-xl text-lg leading-relaxed">
              Openship is explicit about where your data lives, who can touch it,
              and how self-hosted instances talk to the cloud. Here&apos;s the
              short version — the docs go deeper.
            </p>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ title, desc, icon: Icon, href }) => {
              const inner = (
                <>
                  <div
                    className="flex h-11 w-11 items-center justify-center rounded-xl"
                    style={{
                      background: "var(--th-clr-plum-bg)",
                      color: "var(--th-clr-plum)",
                    }}
                  >
                    <Icon className="h-[22px] w-[22px]" />
                  </div>
                  <h3 className="th-text-title mt-5 text-[17px] font-semibold tracking-[-0.01em]">
                    {title}
                  </h3>
                  <p className="th-text-secondary mt-2 text-sm leading-relaxed">
                    {desc}
                  </p>
                </>
              );
              const cls =
                "flex flex-col rounded-2xl border p-6 transition-all";
              const style = {
                background: "var(--th-card-bg)",
                borderColor: "var(--th-card-bd)",
                boxShadow: "var(--th-card-shadow)",
              } as const;
              return href ? (
                <Link key={title} href={href} className={cls} style={style}>
                  {inner}
                </Link>
              ) : (
                <div key={title} className={cls} style={style}>
                  {inner}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Compliance intent (factual, no invented certs) ──────── */}
        <section className="mx-auto max-w-3xl px-6 pb-28">
          <div
            className="rounded-2xl border p-8"
            style={{
              background: "var(--th-bg-subtle)",
              borderColor: "var(--th-bd-subtle)",
            }}
          >
            <h2 className="th-text-heading text-xl font-semibold tracking-[-0.01em]">
              Compliance & responsible disclosure
            </h2>
            <p className="th-text-body mt-3 text-[15px] leading-relaxed">
              Openship is open source, so the security model is auditable by
              anyone. For the strictest requirements, self-hosting keeps all
              project data and network traffic inside your own infrastructure.
              We&apos;re actively working toward formal certifications; this page
              reflects the platform&apos;s current, factual security posture.
            </p>
            <p className="th-text-body mt-3 text-[15px] leading-relaxed">
              Found a vulnerability? Please report it privately at{" "}
              <a
                href="mailto:security@oblien.com"
                className="font-medium underline underline-offset-2"
                style={{ color: "var(--th-clr-plum)" }}
              >
                security@oblien.com
              </a>
              .
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
