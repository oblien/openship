import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

// Fumadocs ships a COMPLETE standalone Tailwind build (its own preflight +
// global `body`/`*` rules). This is a SEPARATE root layout (own <html>/<body>)
// so that build lives ONLY in the docs document — navigating between docs and
// the marketing site is a full page load, so the fumadocs reset can never
// bleed into the product pages. See (site)/layout.tsx for the marketing root.
import "fumadocs-ui/style.css";

const SITE_URL = "https://openship.io";

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
