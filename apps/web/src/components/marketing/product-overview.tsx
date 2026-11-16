import { ArrowRight } from "lucide-react";
import { useCopy } from "@/i18n/use-copy";
import { Link } from "@/i18n/Link";
import {
  CONTROL_PLANE_MODES,
  PRODUCT_ADVANTAGES,
  PRODUCT_QUESTIONS,
  type ProductAdvantage,
} from "@/lib/product";
import { MarketingSection } from "./marketing-section";

export function ProductAdvantages({ items }: { items: readonly ProductAdvantage[] }) {
  const copy = useCopy();
  return (
    <div className="product-grid">
      {items.map((key) => {
        const item = PRODUCT_ADVANTAGES[key];
        return (
          <article key={key} className="product-card">
            <h3>{copy(item.title)}</h3>
            <p>{copy(item.description)}</p>
            <Link href={`/features/${item.feature}`} className="marketing-text-link">
              {copy("Explore this capability")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
        );
      })}
    </div>
  );
}

export function ControlPlaneModes() {
  const copy = useCopy();
  return (
    <MarketingSection
      id="control-plane"
      title="Three ways to run OpenShip"
      description="Choose where the platform lives. Desktop is optional."
    >
      <div className="product-grid">
        {CONTROL_PLANE_MODES.map((mode) => (
          <article className="product-card" key={mode.title}>
            <h3>{copy(mode.title)}</h3>
            <p>{copy(mode.description)}</p>
            <Link href={mode.href} className="marketing-text-link">
              {copy("Get started")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
        ))}
      </div>
    </MarketingSection>
  );
}

export function ProductQuestions() {
  const copy = useCopy();
  return (
    <MarketingSection
      id="platform-questions"
      title="Know the platform"
      description="Deployment choices, performance and recovery, explained."
    >
      <div className="product-questions">
        {PRODUCT_QUESTIONS.map(({ question, answer }) => (
          <details key={question}>
            <summary>{copy(question)}</summary>
            <p>{copy(answer)}</p>
          </details>
        ))}
      </div>
    </MarketingSection>
  );
}
