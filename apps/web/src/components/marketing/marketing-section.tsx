import { useCopy } from "@/i18n/use-copy";

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
  const copy = useCopy();

  return (
    <section id={id} className="marketing-section" aria-labelledby={`${id}-title`}>
      <header className="marketing-section-heading">
        <h2 id={`${id}-title`}>{copy(title)}</h2>
        <p>{copy(description)}</p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
