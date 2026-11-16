import "./comparison-cards.css";
import { ArrowUpRight, Server } from "lucide-react";
import { AppLogo } from "@repo/ui/app-logo";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { comparisonName, type Comparison } from "@/lib/comparisons";

export function ComparisonMark({ comparison }: { comparison: Comparison }) {
  return (
    <span
      className={`compare-mark${comparison.logo ? " compare-provider-mark" : ""}`}
      aria-hidden="true"
    >
      {comparison.logo ? (
        <AppLogo
          slug={comparison.logo}
          src={`/provider-logos/${comparison.logo}.svg`}
          className="size-6"
          invertOnDark={false}
        />
      ) : comparison.group === "vps" ? (
        <Server size={22} />
      ) : (
        <span>{comparison.name.slice(0, 2)}</span>
      )}
    </span>
  );
}

export function ComparisonCards({ items }: { items: readonly Comparison[] }) {
  const copy = useCopy();
  return (
    <div className="compare-grid">
      {items.map((item) => (
        <Link key={item.slug} href={`/compare/${item.slug}`} className="compare-card">
          <div className="compare-card-top">
            <ComparisonMark comparison={item} />
            <ArrowUpRight size={18} aria-hidden="true" />
          </div>
          <h3>
            <bdi>{comparisonName(item, copy)}</bdi>
          </h3>
          <p>{copy(item.summary)}</p>
          <span className="compare-card-link">{copy("Compare with OpenShip")}</span>
        </Link>
      ))}
    </div>
  );
}
