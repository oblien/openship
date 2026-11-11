import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cloudPlanHref } from "@/lib/cloud-links";

export function MarketingCta() {
  return (
    <section className="site-container marketing-start">
      <div className="marketing-start-inner">
        <div>
          <h2>Put it to work.</h2>
          <p>Start on Openship Cloud or deploy on your own infrastructure.</p>
        </div>
        <div className="marketing-start-actions">
          <a href={cloudPlanHref()} className="th-btn rounded-full px-6 py-3 text-[14px]">
            Start on Cloud
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <Link href="/docs/getting-started/quickstart" className="marketing-text-link">
            Self-host for free
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
