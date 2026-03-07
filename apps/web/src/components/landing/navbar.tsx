import Link from "next/link";

export function Navbar() {
  return (
    <header className="fixed top-0 z-50 w-full">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 pt-5">
        {/* ── Logo ────────────────────────────────────────────── */}
        <Link href="/" className="relative z-10 flex items-center gap-2.5">
          <div
            className="h-[30px] w-[30px] shrink-0 rounded-full border-[2.5px] border-[var(--th-text-heading)]"
            aria-hidden="true"
          />
          <span className="text-[16px] font-semibold th-text-heading tracking-[-0.01em]">
            Openship
          </span>
        </Link>

        {/* ── Center pill nav ─────────────────────────────────── */}
        <nav className="nav-pill absolute left-1/2 top-5 hidden -translate-x-1/2 items-center gap-0.5 rounded-full border border-[var(--th-on-05)] px-1.5 py-1.5 backdrop-blur-xl md:flex">
          {[
            { label: "Features", href: "/#features" },
            { label: "Docs", href: "/docs" },
            { label: "Pricing", href: "/pricing" },
          ].map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="nav-pill-item rounded-full px-4 py-2 text-[14px] font-medium th-text-secondary transition-all hover:bg-[var(--th-on-05)] hover:text-[var(--th-text-strong)]"
            >
              {item.label}
            </Link>
          ))}
          <a
            href="https://github.com/oblien/openship"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-pill-item flex items-center gap-1.5 rounded-full px-4 py-2 text-[14px] font-medium th-text-secondary transition-all hover:bg-[var(--th-on-05)] hover:text-[var(--th-text-strong)]"
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
            className="rounded-full px-5 py-2 text-[14px] font-medium th-text-secondary transition-colors hover:text-[var(--th-text-strong)]"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="th-btn rounded-full px-5 py-2 text-[14px]"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

