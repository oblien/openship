import Link from "next/link";

const footerLinks = {
  Product: [
    { label: "Features", href: "/#features" },
    { label: "Install", href: "/download" },
    { label: "Pricing", href: "/pricing" },
    { label: "Docs", href: "/docs" },
  ],
  Developers: [
    { label: "CLI Reference", href: "/docs/cli" },
    { label: "API Reference", href: "/docs/api" },
    { label: "MCP Integration", href: "/docs/mcp" },
    { label: "Self-Hosting Guide", href: "/docs/self-hosting" },
  ],
  Company: [
    { label: "Blog", href: "/blog" },
    { label: "About", href: "/about" },
    { label: "Contact", href: "/contact" },
    { label: "Brand", href: "/brand" },
  ],
  Legal: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "License (MIT)", href: "https://github.com/oblien/openship/blob/main/LICENSE" },
  ],
};

export function Footer() {
  return (
    <footer className="border-t border-[var(--th-bd-subtle)]">
      <div className="mx-auto max-w-7xl px-6 py-16 sm:py-20">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-5">
          {/* Brand column */}
          <div className="lg:col-span-1">
            <Link href="/" className="flex items-center gap-2.5">
              <div
                className="h-7 w-7 shrink-0 rounded-full border-[2px] border-[var(--th-text-heading)]"
                aria-hidden="true"
              />
              <span className="th-text-heading text-base font-semibold tracking-tight">
                Openship
              </span>
            </Link>
            <p className="th-text-muted mt-4 max-w-xs text-sm leading-relaxed">
              Open-source deployment platform. CLI, web dashboard, or desktop app. Install, connect, deploy.
            </p>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([heading, links]) => (
            <div key={heading}>
              <h4 className="th-text-strong text-sm font-semibold">{heading}</h4>
              <ul className="mt-4 space-y-3">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="th-text-secondary text-sm transition-colors hover:text-[var(--th-text-strong)]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="section-divider mt-12" />
        <div className="mt-8 flex flex-col items-center justify-between gap-6 sm:flex-row">
          <p className="th-text-muted text-sm">
            &copy; {new Date().getFullYear()} Oblien LLC. All rights reserved.
          </p>

          {/* Oblien attribution */}
          <a
            href="https://oblien.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 th-text-muted transition-colors hover:text-[var(--th-text-strong)]"
          >
            <span className="text-[13px]">An</span>
            <span
              className="inline-block h-[16px] w-[60px]"
              style={{
                backgroundColor: "var(--th-text-heading)",
                maskImage: "url(https://oblien.com/logo.svg)",
                WebkitMaskImage: "url(https://oblien.com/logo.svg)",
                maskSize: "contain",
                WebkitMaskSize: "contain",
                maskRepeat: "no-repeat",
                WebkitMaskRepeat: "no-repeat",
                maskPosition: "center",
                WebkitMaskPosition: "center",
              }}
              aria-label="Oblien"
            />
            <span className="text-[13px]">project</span>
          </a>

          <div className="flex items-center gap-5">
            {/* GitHub */}
            <a
              href="https://github.com/oblien/openship"
              target="_blank"
              rel="noopener noreferrer"
              className="th-text-muted transition-colors hover:text-[var(--th-text-strong)]"
              aria-label="GitHub"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
            {/* X / Twitter */}
            <a
              href="https://x.com/openship"
              target="_blank"
              rel="noopener noreferrer"
              className="th-text-muted transition-colors hover:text-[var(--th-text-strong)]"
              aria-label="X (Twitter)"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
              </svg>
            </a>
            {/* Discord */}
            <a
              href="https://discord.gg/openship"
              target="_blank"
              rel="noopener noreferrer"
              className="th-text-muted transition-colors hover:text-[var(--th-text-strong)]"
              aria-label="Discord"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
