"use client";

/**
 * Shared layout for /mail/setup-guide/<client>/ pages on the public web.
 *
 * Pure content pages - no auth, no server-side state, no per-server
 * settings rail. Operators reading these are expected to have their
 * Openship admin Overview open in a side tab for the actual host /
 * port / username / password values, so we don't duplicate them here.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Navbar } from "@/components/landing";
import { cn } from "../../_components/lib/cn";

interface GuideLayoutProps {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

const OTHER_GUIDES = [
  { slug: "ios", label: "iOS & macOS Mail" },
  { slug: "android", label: "Android Gmail app" },
  { slug: "desktop", label: "Desktop clients" },
  { slug: "nodemailer", label: "Send via code" },
];

export function GuideLayout({ icon: Icon, title, subtitle, children }: GuideLayoutProps) {
  return (
    <>
      <Navbar />
      <main
        data-section="dark"
        className="relative min-h-screen bg-[#0F0F0F] text-white"
      >
        <div className="mx-auto max-w-3xl px-4 pt-28 pb-24 sm:px-6">
          <Link
            href="/mail"
            className="mb-8 inline-flex items-center gap-1.5 text-sm text-white/60 transition-colors hover:text-white"
          >
            <ArrowLeft className="size-3.5" />
            Back to Mail
          </Link>

          <header className="flex items-start gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-[#1A1A1A]">
              <Icon className="size-7 text-white" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <h1
                className="text-3xl font-medium text-white sm:text-4xl"
                style={{ letterSpacing: "-0.5px" }}
              >
                {title}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-white/60 sm:text-base">
                {subtitle}
              </p>
            </div>
          </header>

          <div className="mt-10 space-y-10">{children}</div>

          {/* Other guides - inline at the bottom, no sticky rail */}
          <nav className="mt-16 border-t border-white/10 pt-8">
            <p className="mb-3 text-[11px] uppercase tracking-[0.18em] text-white/40">
              Other guides
            </p>
            <div className="flex flex-wrap gap-2">
              {OTHER_GUIDES.map((g) => (
                <Link
                  key={g.slug}
                  href={`/mail/setup-guide/${g.slug}`}
                  className="rounded-full border border-white/10 bg-[#141414] px-3 py-1.5 text-sm text-white/70 transition-colors hover:border-white/20 hover:text-white"
                >
                  {g.label}
                </Link>
              ))}
            </div>
          </nav>
        </div>
      </main>
    </>
  );
}

export function GuideSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

export function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold tabular-nums text-white">
            {i + 1}
          </span>
          <div className="pt-0.5 text-sm leading-relaxed text-white/85">{item}</div>
        </li>
      ))}
    </ol>
  );
}

export function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "success";
  children: React.ReactNode;
}) {
  const toneClasses = {
    info: "border-white/10 bg-white/[0.03]",
    warning: "border-amber-500/30 bg-amber-500/[0.06]",
    success: "border-emerald-500/30 bg-emerald-500/[0.06]",
  };
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-sm leading-relaxed text-white/85",
        toneClasses[tone],
      )}
    >
      {children}
    </div>
  );
}
