"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Zap } from "lucide-react";

import { useGitHub } from "@/context/GitHubContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { PRODUCT_TIPS } from "./home-tips";

interface HomeTipCardProps {
  projectCount: number;
  loading: boolean;
}

interface HomeTip {
  text: string;
  href: string;
  label: string;
}

export default function HomeTipCard({ projectCount, loading }: HomeTipCardProps) {
  const gitHub = useGitHub();
  const { selfHosted } = usePlatform();
  const { t } = useI18n();
  const c = t.overview.homeTip;

  // A contextual onboarding nudge always wins over the random product tip:
  // connect GitHub if disconnected, else create the first project.
  const busy = loading || gitHub.loading;
  const contextual: HomeTip | null = !gitHub.connected
    ? { text: c.connectText, href: "/settings", label: c.connectLabel }
    : !busy && projectCount === 0
      ? { text: c.createText, href: "/new", label: c.createLabel }
      : null;

  // Otherwise rotate through the product tips — a fresh one per mount (per
  // visit). Only tips whose route exists on this install. Index 0 on SSR /
  // first render (deterministic → no hydration mismatch), randomized on mount.
  const pool = useMemo(
    () => PRODUCT_TIPS.filter((tip) => selfHosted || !tip.selfHostedOnly),
    [selfHosted],
  );
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (pool.length > 1) setIdx(Math.floor(Math.random() * pool.length));
  }, [pool.length]);

  // Contextual nudge wins; otherwise resolve the picked product tip's copy from
  // i18n (overview.homeTip.tips.<id>).
  const tipCopy = c.tips as Record<string, { text: string; label: string }>;
  let tip = contextual;
  if (!tip) {
    const pick = pool[idx] ?? pool[0];
    const copy = pick ? tipCopy[pick.id] : undefined;
    if (pick && copy) tip = { text: copy.text, href: pick.href, label: copy.label };
  }
  if (!tip) return null;

  return (
    <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="size-4 text-primary" />
        <h3 className="font-semibold text-foreground text-sm">{c.quickTip}</h3>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">{tip.text}</p>
      <Link
        href={tip.href}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 mt-3 transition-colors"
      >
        {tip.label}
        <ArrowRight className="size-3.5 rtl:rotate-180" />
      </Link>
    </div>
  );
}
