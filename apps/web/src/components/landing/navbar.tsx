"use client";

import { useState } from "react";
import Link from "next/link";

const NAV_ITEMS = [
  { label: "Features", href: "/features" },
  { label: "Emails", href: "/mail" },
  { label: "Docs", href: "/docs" },
  { label: "Roadmap", href: "/roadmap" },
  { label: "Changelog", href: "/changelog" },
  { label: "Pricing", href: "/pricing" },
];

const GITHUB_URL = "https://github.com/oblien/openship";

/**
 * Navbar - a solid bar on the page's own rules.
 *
 * Three columns rather than a flex row with a centred absolute box: the side
 * columns are 1fr each, so the links sit on the true horizontal centre of the
 * bar no matter how wide the wordmark or the action cluster turn out to be.
 * A centred flex row puts them optically left, because the wordmark is wider
 * than the cluster opposite it.
 *
 * The bar is opaque, so it needs no awareness of what is scrolling under it.
 * That is what retired the old scroll listener that recoloured every control
 * whenever a dark plate passed beneath.
 */
export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="lp-nav">
      <div className="lp-nav-bar">
        {/* ── Logo ────────────────────────────────────────────── */}
        <Link href="/" className="lp-nav-brand">
          <span className="lp-nav-brand-mark" aria-hidden="true" />
          <span className="lp-nav-brand-word">Openship</span>
        </Link>

        {/* ── Centre links ────────────────────────────────────── */}
        <nav className="lp-nav-links">
          {NAV_ITEMS.map((item) => (
            <Link key={item.label} href={item.href} className="lp-nav-link">
              {item.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="lp-nav-link"
          >
            <svg className="lp-nav-link-icon" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
        </nav>

        {/* ── Actions ─────────────────────────────────────────── */}
        <div className="lp-nav-actions">
          <Link href="/login" className="lp-nav-btn">
            Log in
          </Link>

          {/* Split button: the arrow gets its own cell behind a hairline, so
              the rule reads as part of the control rather than an icon
              floating inside the label's padding. */}
          <Link href="/download" className="lp-nav-cta">
            <span className="lp-nav-cta-label">Download</span>
            <span className="lp-nav-cta-arrow" aria-hidden="true">
              <svg viewBox="0 0 14 14" fill="none">
                <path
                  d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="lp-nav-toggle"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              {mobileOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* ── Mobile panel ────────────────────────────────────── */}
      {mobileOpen && (
        <div className="lp-nav-sheet" aria-modal="true" role="dialog">
          <div
            className="lp-nav-sheet-scrim"
            onClick={() => setMobileOpen(false)}
          />
          <nav className="lp-nav-sheet-panel">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className="lp-nav-sheet-link"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              className="lp-nav-sheet-link"
            >
              GitHub
            </a>

            <div className="lp-nav-sheet-rule" />

            <Link
              href="/login"
              onClick={() => setMobileOpen(false)}
              className="lp-nav-sheet-link"
            >
              Log in
            </Link>
            <Link
              href="/download"
              onClick={() => setMobileOpen(false)}
              className="lp-nav-sheet-cta"
            >
              Download
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}
