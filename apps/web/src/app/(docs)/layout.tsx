import type { Metadata, Viewport } from "next";
import type { CSSProperties, ReactNode } from "react";

// Fumadocs ships a COMPLETE standalone Tailwind build (its own preflight +
// global `body`/`*` rules). This is a SEPARATE root layout (own <html>/<body>)
// so that build lives ONLY in the docs document — navigating between docs and
// the marketing site is a full page load, so the fumadocs reset can never
// bleed into the product pages. See (site)/layout.tsx for the marketing root.
import "fumadocs-ui/style.css";
// Match the marketing site's typeface. fonts.css is PURE @font-face (no Tailwind
// reset), so it registers Gellix in this isolated docs document without pulling
// the marketing globals into the fumadocs build.
import "../../styles/fonts.css";
// Docs-only tweaks layered after fumadocs' stylesheet (e.g. sidebar cursor).
import "../../styles/docs-overrides.css";

const SITE_URL = "https://openship.io";

// Same stack as the marketing site (globals.css `--font-sans`). Fumadocs renders
// off the Tailwind `--font-sans` token, so overriding it here re-fonts all docs.
const FONT_SANS = "'Gellix', 'SF Arabic', system-ui, -apple-system, sans-serif";

export const metadata: Metadata = {
  // Docs pages set only relative OG/canonical URLs; this resolves them.
  metadataBase: new URL(SITE_URL),
  title: { default: "Openship Docs", template: "%s – Openship" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={{ "--font-sans": FONT_SANS } as CSSProperties}
    >
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      <body className="min-h-screen antialiased" style={{ fontFamily: "var(--font-sans)" }}>
        {children}
      </body>
    </html>
  );
}
