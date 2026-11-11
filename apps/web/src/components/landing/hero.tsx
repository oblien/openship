import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cloudPlanHref } from "@/lib/cloud-links";
import { cloudFrom, getCloudPricing } from "@/lib/pricing";

const STACKS = [
  { name: "Next.js", icon: "https://cdn.simpleicons.org/nextdotjs/000000" },
  { name: "Node", icon: "https://cdn.simpleicons.org/nodedotjs/5FA04E" },
  { name: "Python", icon: "https://cdn.simpleicons.org/python/3776AB" },
  { name: "Go", icon: "https://cdn.simpleicons.org/go/00ADD8" },
  { name: "Rust", icon: "https://cdn.simpleicons.org/rust/000000" },
  { name: "Docker", icon: "https://cdn.simpleicons.org/docker/2496ED" },
  { name: "Postgres", icon: "https://cdn.simpleicons.org/postgresql/4169E1" },
  { name: "Redis", icon: "https://cdn.simpleicons.org/redis/FF4438" },
  { name: "Rails", icon: "https://cdn.simpleicons.org/rubyonrails/D30001" },
  { name: "Laravel", icon: "https://cdn.simpleicons.org/laravel/FF2D20" },
  { name: "Django", icon: "https://cdn.simpleicons.org/django/092E20" },
  { name: "Bun", icon: "https://cdn.simpleicons.org/bun/000000" },
];

export async function Hero() {
  const pricing = await getCloudPricing();
  const from = cloudFrom(pricing);
  const cloudHref = cloudPlanHref();

  return (
    <section className="hero-section relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden">
      {/* ═══════════════ Background layers ═══════════════ */}
      <div className="hero-grain absolute inset-0" aria-hidden="true" />
      <div className="hero-grid absolute inset-0" aria-hidden="true" />

      {/* ── Bottom aurora glow ── */}
      <div className="hero-aurora" aria-hidden="true">
        <div className="hero-aurora-core" />
        <div className="hero-aurora-wing hero-aurora-wing--left" />
        <div className="hero-aurora-wing hero-aurora-wing--right" />
      </div>

      {/* ═══════════════ Content ═══════════════ */}
      <div className="relative z-20 mx-auto w-full max-w-[860px] px-6 text-center">
        <Link href="/pricing" className="hero-cloud-price animate-fade-in-up">
          <span>Openship Cloud</span>
          {from && <strong>From {from}/month</strong>}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>

        {/* Headline */}
        <h1 className="animate-fade-in-up animate-delay-100">
          <span className="block text-[clamp(2.5rem,5.5vw,4.25rem)] font-medium leading-[1.08] tracking-[-0.02em] th-text-heading">
            Deploy anything.
          </span>
          <span className="hero-headline-second block text-[clamp(2.5rem,5.5vw,4.25rem)] font-light italic leading-[1.08] tracking-[-0.015em]">
            Own everything.
          </span>
        </h1>

        <p className="animate-fade-in-up animate-delay-200 mx-auto mt-6 max-w-[520px] text-[16px] leading-[1.65] th-text-body">
          Run your apps, databases, and workflows from one place. Start on Openship Cloud or connect
          your own servers.
        </p>

        <div className="hero-actions animate-fade-in-up animate-delay-300">
          <a href={cloudHref} className="th-btn rounded-full px-7 py-3 text-[15px]">
            Start on Cloud <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <Link
            href="/docs/getting-started/quickstart"
            className="th-btn-ghost rounded-full px-7 py-3 text-[15px]"
          >
            Self-host for free
          </Link>
        </div>
      </div>

      {/* ═══════════════ Stack ticker ═══════════════ */}
      <div className="animate-fade-in-up animate-delay-500 relative z-10 mt-16 w-full max-w-[820px] px-6">
        <p className="mb-6 text-center text-[13px] font-medium uppercase tracking-[0.1em] th-text-muted">
          Designed for your favorite stack
        </p>
        <div className="hero-ticker-mask overflow-hidden">
          <div className="hero-ticker flex w-max items-center gap-12">
            {[0, 1].map((i) => (
              <div key={i} className="flex shrink-0 items-center gap-12">
                {STACKS.map((s) => (
                  <div
                    key={`${i}-${s.name}`}
                    className="flex shrink-0 items-center gap-2.5 opacity-50"
                    style={{ filter: "grayscale(1) brightness(0.45) contrast(1.1)" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.icon}
                      alt={s.name}
                      className="h-[26px] w-[26px] object-contain"
                      loading="lazy"
                    />
                    <span className="whitespace-nowrap text-[14px] font-medium th-text-secondary">
                      {s.name}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Edge fades */}
      <div className="hero-edge-fade-top absolute top-0 left-0 right-0 h-20" aria-hidden="true" />
      <div
        className="hero-edge-fade-bottom absolute bottom-0 left-0 right-0 h-40"
        aria-hidden="true"
      />
    </section>
  );
}
