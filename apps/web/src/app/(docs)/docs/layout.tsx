import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { docsSource } from "@/lib/source";
import type { ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { DocsSearch } from "@/components/docs/search";

// fumadocs-ui/style.css is imported once in the (docs) ROOT layout so the
// stylesheet is confined to the docs document (see (docs)/layout.tsx).

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{ defaultTheme: "light", enableSystem: true }}
      search={{ SearchDialog: DocsSearch }}
    >
      <DocsLayout
        tree={docsSource.pageTree}
        containerProps={{ className: "openship-docs" }}
        sidebar={{
          defaultOpenLevel: 0,
          className: "docs-navigation",
          collapsible: false,
        }}
        nav={{
          mode: "top",
          title: (
            <span className="docs-brand">
              <span className="docs-brand-mark" aria-hidden="true" />
              <span>OpenShip</span>
              <span className="docs-brand-label">Documentation</span>
            </span>
          ),
          url: "/docs",
        }}
        links={[
          { text: "Guides", url: "/docs/guides", active: "nested-url" },
          { text: "API & SDK", url: "/docs/api", active: "nested-url" },
          { text: "CLI", url: "/docs/cli", active: "nested-url" },
          { text: "Website", url: "/", active: "none" },
          {
            type: "icon",
            label: "GitHub",
            text: "GitHub",
            url: "https://github.com/oblien/openship",
            external: true,
            icon: <Icon name="github" size={18} />,
          },
          {
            type: "custom",
            children: (
              <a className="th-btn docs-dashboard-link" href="https://app.openship.io">
                Open Cloud <Icon name="arrow-up-right" size={14} aria-hidden="true" />
              </a>
            ),
          },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
