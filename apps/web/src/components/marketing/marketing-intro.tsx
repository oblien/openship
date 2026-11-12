import { useCopy } from "@/i18n/use-copy";

import type { ReactNode } from "react";

/** The same compact introduction across the public product pages. */
export function MarketingIntro({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  const copy = useCopy();

  return (
    <header className="site-container marketing-intro">
      <div>
        <p className="marketing-eyebrow">{copy(eyebrow)}</p>
        <h1 className="marketing-title">{copy(title)}</h1>
      </div>
      <div className="marketing-intro-copy">
        <p>{copy(description)}</p>
        {children}
      </div>
    </header>
  );
}
