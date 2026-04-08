"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const NAV_ITEMS = [
  { label: "Features", href: "/#features" },
  { label: "Install", href: "/download" },
  { label: "Docs", href: "/docs" },
  { label: "Pricing", href: "/pricing" },
];

const GITHUB_URL = "https://github.com/openshiporg/openship";

export function Navbar() {
  const [dark, setDark] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleScroll = useCallback(() => {
    const navBottom = 80;
    const darkEls = document.querySelectorAll('[data-section="dark"]');
    let inDark = false;
    darkEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top <= navBottom && rect.bottom > 0) inDark = true;
    });
    setDark(inDark);
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  return (
    <header className="fixed top-0 z-50 w-full">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 pt-5">
        {/* ── Logo ────────────────────────────────────────────── */}
        <Link href="/" className="relative z-10 flex items-center gap-2.5">
          <div
            className="h-[30px] w-[30px] shrink-0 rounded-full"
            style={{
              borderWidth: "2.5px",
              borderStyle: "solid",
              borderColor: dark ? "rgba(255,255,255,.9)" : "var(--th-text-heading)",
              transition: "border-color .3s",
            }}
            aria-hidden="true"
          />
          <span
            className="text-[16px] font-semibold tracking-[-0.01em]"
            style={{
              color: dark ? "rgba(255,255,255,.95)" : "var(--th-text-heading)",
              transition: "color .3s",
            }}
          >
            Openship
          </span>
        </Link>

        {/* ── Center pill nav ─────────────────────────────────── */}
        <nav
          className="absolute left-1/2 top-5 hidden -translate-x-1/2 items-center gap-0.5 rounded-full px-1.5 py-1.5 backdrop-blur-xl md:flex"
          style={{
            background: dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.72)",
            border: dark ? "1px solid rgba(255,255,255,.10)" : "1px solid var(--th-on-05)",
            boxShadow: dark ? "none" : "0 0 0 1px rgba(0,0,0,.03), 0 2px 8px rgba(0,0,0,.04)",
            transition: "background .3s, border .3s, box-shadow .3s",
          }}
        >
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="nav-pill-item rounded-full px-4 py-2 text-[14px] font-medium transition-all"
              style={{
                color: dark ? "rgba(255,255,255,.55)" : "var(--th-text-secondary)",
              }}
            >
              {item.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-pill-item flex items-center gap-1.5 rounded-full px-4 py-2 text-[14px] font-medium transition-all"
            style={{
              color: dark ? "rgba(255,255,255,.55)" : "var(--th-text-secondary)",
            }}
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
        </nav>

        {/* ── Right side CTA ──────────────────────────────────── */}
        <div className="relative z-10 flex items-center gap-3">
          <Link
            href="/login"
            className="hidden rounded-full px-5 py-2 text-[14px] font-medium transition-colors sm:inline-block"
            style={{
              color: dark ? "rgba(255,255,255,.55)" : "var(--th-text-secondary)",
            }}
          >
            Log in
          </Link>
          <Link
            href="/download"
            className="hidden rounded-full px-5 py-2 text-[14px] font-medium transition-all sm:inline-block"
            style={{
              background: dark ? "#fff" : "var(--th-btn-bg)",
              color: dark ? "#000" : "var(--th-btn-text)",
            }}
          >
            Download
          </Link>

          {/* ── Hamburger (mobile only) ──────────────────────── */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full md:hidden"
            style={{
              background: dark ? "rgba(255,255,255,.10)" : "var(--th-sf-04)",
            }}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke={dark ? "#fff" : "var(--th-text-heading)"} strokeWidth={2}>
              {mobileOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* ── Mobile slide-out panel ──────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" aria-modal="true">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          {/* Panel */}
          <nav
            className="absolute right-0 top-0 flex h-full w-[280px] flex-col gap-1 bg-[var(--th-bg-page)] px-6 pt-24 shadow-2xl"
          >
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className="rounded-xl px-4 py-3 text-[15px] font-medium th-text-body transition-colors hover:bg-[var(--th-sf-04)]"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2 rounded-xl px-4 py-3 text-[15px] font-medium th-text-body transition-colors hover:bg-[var(--th-sf-04)]"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              GitHub
            </a>

            <div className="my-3 h-px bg-[var(--th-divider)]" />

            <Link
              href="/login"
              onClick={() => setMobileOpen(false)}
              className="rounded-xl px-4 py-3 text-[15px] font-medium th-text-secondary transition-colors hover:bg-[var(--th-sf-04)]"
            >
              Log in
            </Link>
            <Link
              href="/download"
              onClick={() => setMobileOpen(false)}
              className="mt-1 rounded-xl bg-[var(--th-btn-bg)] px-4 py-3 text-center text-[15px] font-medium text-[var(--th-btn-text)]"
            >
              Download
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

