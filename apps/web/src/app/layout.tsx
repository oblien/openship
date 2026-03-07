import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Openship — Open Source, Self-Hostable Deployment Platform",
  description:
    "Deploy anything, own everything. Self-hostable, AI-powered deployment platform with free SSL, unlimited domains, instant rollbacks, and CLI/MCP support. Open source and free forever.",
  keywords: [
    "deployment platform",
    "self-hosted",
    "open source",
    "AI deployments",
    "vercel alternative",
    "free SSL",
    "unlimited domains",
    "CLI deploy",
    "MCP",
    "instant rollback",
    "git push deploy",
    "docker deploy",
  ],
  authors: [{ name: "Openship" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://openship.dev",
    siteName: "Openship",
    title: "Openship — Open Source, Self-Hostable Deployment Platform",
    description:
      "Deploy anything, own everything. AI-powered builds, free SSL, unlimited domains, instant rollbacks — without the vendor lock-in.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Openship — Deploy Anything. Own Everything.",
    description:
      "Open source, self-hostable deployment platform with AI-powered builds and instant rollbacks.",
    creator: "@openship",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="preconnect" href="https://cdn.oblien.com" crossOrigin="anonymous" />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
