import type { ReactNode } from "react";

/** Reuse the product's screenshots; theme changes do not need client JavaScript. */
export function DocsScreenshot({
  name,
  alt,
  caption,
  eager = false,
}: {
  name: "connect" | "build" | "ship" | "route" | "operate";
  alt: string;
  caption?: ReactNode;
  eager?: boolean;
}) {
  const base = `/screenshots/en/walkthrough/${name}`;
  return (
    <figure className="docs-screenshot not-prose">
      {(["light", "dark"] as const).map((theme) => {
        const src = `${base}${theme === "light" ? "-light" : ""}.webp`;
        return (
          <a
            key={theme}
            className={`docs-screenshot-${theme}`}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
          >
            {/* Native images keep the full-resolution screenshot link and avoid a second asset pipeline. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              width={1800}
              height={1350}
              loading={eager ? "eager" : "lazy"}
              decoding="async"
            />
          </a>
        );
      })}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
