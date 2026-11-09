import type { ReactNode } from "react";

/** The same compact introduction across the public product pages. */
export function MarketingIntro({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="site-container marketing-intro">
      <div>
        <p className="marketing-eyebrow">{eyebrow}</p>
        <h1 className="marketing-title">{title}</h1>
      </div>
      <div className="marketing-intro-copy">
        <p>{description}</p>
        {children}
      </div>
    </header>
  );
}
