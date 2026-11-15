import { useCopy } from "@/i18n/use-copy";

import { Link } from "@/i18n/Link";
import { ArrowRight } from "lucide-react";
import { cloudPlanHref } from "@/lib/cloud-links";

export function MarketingCta() {
  const copy = useCopy();

  return (
    <section className="site-container marketing-start">
      <div className="marketing-start-inner">
        <div>
          <h2>{copy("Put it to work.")}</h2>
          <p>{copy("Start on OpenShip Cloud or deploy on your own infrastructure.")}</p>
        </div>
        <div className="marketing-start-actions">
          <a href={cloudPlanHref()} className="th-btn rounded-full px-6 py-3 text-[14px]">
            {copy("Start on Cloud")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <Link href="/docs/getting-started/quickstart" className="marketing-text-link">
            {copy("Self-host for free")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
