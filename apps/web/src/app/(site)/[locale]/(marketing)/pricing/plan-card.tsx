import type { ReactNode } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { UI } from "@/lib/pricing";

export const formatPlanCount = (value: number | null | undefined) =>
  value === undefined ? "Not listed" : value === null ? "No set limit" : value.toLocaleString("en");

type Fact = { label: string; value: string; href?: string };

export function PlanFacts({ facts, checked = false }: { facts: Fact[]; checked?: boolean }) {
  const copy = useCopy();

  return (
    <dl className="pp-plan-limits">
      {facts.map(({ label, value, href }) => (
        <div className="pp-plan-limit" key={label}>
          <dt className={checked ? "flex items-center gap-2" : undefined}>
            {checked && <Check className="size-4 shrink-0" aria-hidden="true" />}
            {href ? <Link href={href}>{copy(label)}</Link> : copy(label)}
          </dt>
          <dd>{copy(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PlanCard({
  name,
  description,
  amount,
  per,
  billingNote,
  href,
  cta,
  popular,
  support,
  benefits = [],
  children,
}: {
  name: string;
  description: string;
  amount: string;
  per?: string | null;
  billingNote: ReactNode;
  href: string;
  cta: string;
  popular?: boolean;
  support: string;
  benefits?: string[];
  children: ReactNode;
}) {
  const copy = useCopy();

  return (
    <article
      className={`pp-plan${popular ? " pp-plan--highlight" : ""}`}
      aria-label={copy("{value0} plan", { value0: String(name) })}
    >
      <div className="pp-plan-heading">
        <h3 className="pp-plan-name">{copy(name)}</h3>
        {popular && <span className="pp-plan-ribbon">{copy(UI.mostPopular)}</span>}
      </div>
      <p className="pp-plan-lead">{copy(description)}</p>
      <div className="pp-plan-price-block">
        <div className="pp-plan-price">
          <bdi className="pp-plan-amt">{copy(amount)}</bdi>
          {per && <span className="pp-plan-per">{copy(per)}</span>}
        </div>
        <p className="pp-plan-billing">{copy(billingNote)}</p>
      </div>
      <Link href={href} className="pp-plan-cta">
        {copy(cta)} <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
      <div className="pp-plan-details">{children}</div>
      <ul className="pp-plan-support">
        {[...benefits, support].map((benefit) => (
          <li key={benefit}>
            <Check className="size-4" aria-hidden="true" />
            {copy(benefit)}
          </li>
        ))}
      </ul>
    </article>
  );
}
