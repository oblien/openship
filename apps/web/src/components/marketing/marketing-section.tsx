import type { ReactNode } from "react";

export function MarketingSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="marketing-section" aria-labelledby={`${id}-title`}>
      <header className="marketing-section-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
