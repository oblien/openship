import { ArrowRight } from "lucide-react";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { ComparisonCards } from "@/components/marketing/comparison-cards";
import { COMPARISONS } from "@/lib/comparisons";

const featured = COMPARISONS.filter(({ slug }) =>
  ["vercel", "railway", "coolify", "self-managed-vps"].includes(slug),
);

/** Entry point to the sourced comparisons; provider claims live in one catalog. */
export function Comparison() {
  const copy = useCopy();
  return (
    <section id="comparison" className="cmp-section" aria-labelledby="comparison-title">
      <div className="site-container">
        <div className="cmp-head">
          <div>
            <p className="cmp-eyebrow">{copy("Compare platforms")}</p>
            <h2 id="comparison-title" className="cmp-title">
              {copy("Your stack.")}
              <br />
              <span>{copy("Your choice.")}</span>
            </h2>
          </div>
          <p className="cmp-sub">
            {copy(
              "A good platform fits the way you build. Compare the tradeoffs, then plan your move with a clear view of what transfers.",
            )}
          </p>
        </div>
        <ComparisonCards items={featured} />
        <Link href="/compare" className="marketing-text-link mt-8">
          {copy("All comparisons")}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
