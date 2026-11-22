import type { ReactNode } from "react";
import { MarqueeTrack } from "./marquee-track";
import styles from "./card-marquee.module.css";

export function MarqueeHeading({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <header className="site-container flex flex-wrap items-end justify-between gap-6">
      <h2 id={id} className="max-w-xl text-balance text-4xl font-medium tracking-tight th-text-heading sm:text-5xl">
        {title}
      </h2>
      {children}
    </header>
  );
}

export function CardMarquee({ id, dir, reverse, renderCards }: {
  id?: string;
  dir?: "ltr" | "rtl";
  reverse?: boolean;
  renderCards: (duplicate: boolean) => ReactNode;
}) {
  return (
    <div id={id} className={styles.window} dir={dir} data-reverse={reverse || undefined}>
      <MarqueeTrack>
        {[false, true].map((duplicate) => (
          <div key={String(duplicate)} className={styles.group} aria-hidden={duplicate || undefined}>
            {renderCards(duplicate)}
          </div>
        ))}
      </MarqueeTrack>
    </div>
  );
}
