import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { docsSource } from "@/lib/source";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, LifeBuoy } from "lucide-react";

// fumadocs-ui/style.css is imported once in the (docs) ROOT layout so the
// stylesheet is confined to the docs document (see (docs)/layout.tsx).

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ defaultTheme: "system", enableSystem: true }}>
      <DocsLayout
        tree={docsSource.pageTree}
        containerProps={{ className: "openship-docs" }}
        sidebar={{
          defaultOpenLevel: 0,
          footer: (
            <Link className="docs-sidebar-help" href="/docs/troubleshooting">
              <LifeBuoy size={17} aria-hidden="true" />
              Troubleshooting
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          ),
        }}
        nav={{
          mode: "top",
          title: (
            <span className="docs-brand">
              <span className="docs-brand-mark" aria-hidden="true" />
              <span>OpenShip</span>
              <span className="docs-brand-label">Docs</span>
            </span>
          ),
          url: "/docs",
        }}
        githubUrl="https://github.com/oblien/openship"
        links={[
          { text: "Guides", url: "/docs/guides", active: "nested-url" },
          { text: "API & SDK", url: "/docs/api", active: "nested-url" },
          { text: "CLI", url: "/docs/cli", active: "nested-url" },
          { text: "Website", url: "/", active: "none" },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
