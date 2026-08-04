import Link from "next/link";

const footerLinks = {
  Product: [
    { label: "Features", href: "/#features" },
    { label: "Install", href: "/download" },
    { label: "Pricing", href: "/pricing" },
    { label: "Docs", href: "/docs" },
    { label: "Changelog", href: "/changelog" },
  ],
  Developers: [
    { label: "CLI Reference", href: "/docs/cli" },
    { label: "API Reference", href: "/docs/api" },
    { label: "Architecture", href: "/docs/architecture/overview" },
    { label: "Security", href: "/docs/security/permissions" },
  ],
  Company: [
    { label: "Resources", href: "/resources" },
    { label: "Trust & Security", href: "/trust" },
    { label: "About", href: "/about" },
    { label: "Contact", href: "/contact" },
  ],
  Legal: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "License (Apache 2.0)", href: "https://github.com/oblien/openship/blob/main/LICENSE" },
  ],
};

const SOCIALS = [
  {
    label: "GitHub",
    href: "https://github.com/oblien/openship",
    path: "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z",
  },
  {
    label: "X (Twitter)",
    href: "https://x.com/openshipio",
    path: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  },
  {
    label: "Discord",
    href: "https://discord.gg/Q9eWNCeXjg",
    path: "M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z",
  },
];

/**
 * Footer - the page's only full-bleed plate.
 *
 * It ignores the rails on purpose. Everything above it is held inside the
 * measure; the footer running edge to edge is what tells you the document
 * has ended rather than merely paused.
 */
export function Footer() {
  return (
    <footer className="ft">
      <div className="ft-top">
        <div className="ft-editorial">
          <h2 className="ft-h2">
            Open-source deployment<br />platform.
          </h2>
          <p className="ft-sub">
            CLI, web dashboard, or desktop app. Install, connect, deploy.
          </p>
        </div>

        <div className="ft-cols">
          {Object.entries(footerLinks).map(([heading, links]) => (
            <div key={heading} className="ft-col">
              <div className="ft-col-label">{heading}</div>
              <div className="ft-col-links">
                {links.map((link) => (
                  <Link key={link.label} href={link.href} className="ft-link">
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}

          <div className="ft-col">
            <div className="ft-col-label">Connect</div>
            <div className="ft-socials">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ft-social"
                  aria-label={s.label}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d={s.path} />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="ft-copy-row">
        <a
          href="https://oblien.com"
          target="_blank"
          rel="noopener noreferrer"
          className="ft-oblien"
        >
          <span>An</span>
          <span className="ft-oblien-mark" aria-label="Oblien" />
          <span>project</span>
        </a>
        <span className="ft-copy">
          &copy; {new Date().getFullYear()} &middot; OBLIEN LLC &middot; ALL RIGHTS RESERVED
        </span>
      </div>

      {/* Giant wordmark, stretched to the full width of the plate. Sized in
          vw so it always spans edge to edge, whatever the viewport. Set in
          Geist Pixel on its circle shape - the dots are the mark, so it
          needs nothing sitting on top of it. */}
      <div className="ft-wordmark-wrap">
        <div className="ft-wordmark" aria-hidden="true">Openship</div>
      </div>
    </footer>
  );
}
