"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { reportCaughtError } from "@repo/core/diagnostics";
import { cloudPlanHref } from "@/lib/cloud-links";

type NavLink = { label: string; href: string; hint?: string };
type NavGroup = { label: string; items: NavLink[] };
type NavEntry = NavLink | NavGroup;

const NAV: NavEntry[] = [
  {
    label: "Product",
    items: [
      { label: "Features", href: "/features", hint: "Everything the platform does" },
      { label: "Apps", href: "/apps", hint: "Ready-to-deploy templates" },
      { label: "Email", href: "/mail", hint: "Your own mail server, any domain" },
      { label: "Desktop app", href: "/download", hint: "Mac, Windows and Linux" },
    ],
  },
  { label: "Pricing", href: "/pricing" },
  { label: "Migrate", href: "/migrate" },
  { label: "Docs", href: "/docs" },
  {
    label: "Resources",
    items: [
      { label: "Blog", href: "/blog", hint: "Guides and product news" },
      { label: "Changelog", href: "/changelog", hint: "What shipped, release by release" },
      { label: "Support", href: "/support", hint: "Talk to the Openship team" },
    ],
  },
];

const isGroup = (entry: NavEntry): entry is NavGroup => "items" in entry;
const CLOUD_HREF = cloudPlanHref();
const GITHUB_URL = "https://github.com/oblien/openship";
const GITHUB_PATH =
  "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="h-3 w-3 transition-transform duration-200"
      style={{ transform: open ? "rotate(180deg)" : undefined }}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}

/** Dropdown inside the pill. Opens on hover with a mouse, on click or Enter otherwise. */
function NavDropdown({
  group,
  dark,
  open,
  onOpen,
  onClose,
}: {
  group: NavGroup;
  dark: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const active = group.items.some((i) => pathname === i.href || pathname?.startsWith(i.href + "/"));
  const canHover = () => window.matchMedia("(hover: hover)").matches;

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        if (!canHover()) return;
        clearTimeout(closeTimer.current);
        onOpen();
      }}
      onMouseLeave={() => {
        if (canHover()) closeTimer.current = setTimeout(onClose, 120);
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => (canHover() && e.detail > 0 ? onOpen() : open ? onClose() : onOpen())}
        className={`nav-pill-item flex items-center gap-1 rounded-full py-2 pl-3 pr-2.5 text-[14px] font-medium transition-all ${
          active || open ? "bg-[var(--th-sf-04)]" : ""
        }`}
        style={{ color: dark ? "rgba(255,255,255,.55)" : "var(--th-text-secondary)" }}
      >
        {group.label}
        <Chevron open={open} />
      </button>
      <div
        className={`absolute left-[-8px] top-[calc(100%+14px)] grid min-w-[290px] gap-0.5 rounded-[18px] border border-[var(--th-bd-default)] bg-[var(--th-bg-page)] p-2 shadow-[0_12px_32px_rgba(0,0,0,.10),0_2px_6px_rgba(0,0,0,.04)] transition-all duration-150 before:absolute before:inset-x-0 before:-top-3.5 before:h-3.5 ${
          open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-1 opacity-0"
        }`}
      >
        {group.items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className="rounded-xl px-3 py-2.5 transition-colors hover:bg-[var(--th-sf-04)]"
          >
            <span className="block text-[14px] font-semibold text-[var(--th-text-title)]">
              {item.label}
            </span>
            {item.hint && (
              <span className="block text-[12.5px] text-[var(--th-text-secondary)]">
                {item.hint}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Navbar() {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [stars, setStars] = useState<number | null>(null);
  const githubLabel =
    stars === null
      ? "Stars"
      : `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(stars).toLowerCase()} stars`;
  const githubDescription =
    stars === null
      ? "Star Openship on GitHub"
      : `Openship on GitHub — ${stars.toLocaleString("en-US")} stars`;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/github-stars", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!controller.signal.aborted && Number.isSafeInteger(data?.stars) && data.stars >= 0) {
          setStars(data.stars);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) reportCaughtError(error, "web/landing/navbar.github-stars");
      });
    return () => controller.abort();
  }, []);

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

  const linkColor = dark ? "rgba(255,255,255,.55)" : "var(--th-text-secondary)";

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

        {/* ── Center pill nav (same shape; links grouped into two dropdowns) ── */}
        <nav
          aria-label="Main navigation"
          className="absolute left-1/2 top-5 hidden -translate-x-1/2 items-center gap-0.5 rounded-full px-1.5 py-1.5 backdrop-blur-xl xl:flex"
          style={{
            background: dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.72)",
            border: dark ? "1px solid rgba(255,255,255,.10)" : "1px solid var(--th-on-05)",
            boxShadow: dark ? "none" : "0 0 0 1px rgba(0,0,0,.03), 0 2px 8px rgba(0,0,0,.04)",
            transition: "background .3s, border .3s, box-shadow .3s",
          }}
        >
          {NAV.map((entry) =>
            isGroup(entry) ? (
              <NavDropdown
                key={entry.label}
                group={entry}
                dark={dark}
                open={openGroup === entry.label}
                onOpen={() => setOpenGroup(entry.label)}
                onClose={() => setOpenGroup((g) => (g === entry.label ? null : g))}
              />
            ) : (
              <Link
                key={entry.label}
                href={entry.href}
                aria-current={
                  pathname === entry.href || pathname?.startsWith(entry.href + "/")
                    ? "page"
                    : undefined
                }
                className="nav-pill-item rounded-full px-3 py-2 text-[14px] font-medium transition-all aria-[current=page]:bg-[var(--th-sf-04)]"
                style={{ color: linkColor }}
              >
                {entry.label}
              </Link>
            ),
          )}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={githubDescription}
            title={githubDescription}
            className="nav-pill-item flex items-center gap-1.5 rounded-full px-3 py-2 text-[14px] font-medium transition-all"
            style={{ color: linkColor }}
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d={GITHUB_PATH} />
            </svg>
            {githubLabel}
          </a>
        </nav>

        {/* ── Right side: Download (outlined) + Start on Cloud (primary) ── */}
        <div className="relative z-10 flex items-center gap-3">
          <Link
            href="/login"
            className="hidden rounded-full px-5 py-2 text-[14px] font-medium transition-colors sm:inline-block"
            style={{ color: linkColor }}
          >
            Log in
          </Link>
          <Link
            href="/download"
            className="hidden rounded-full px-5 py-2 text-[14px] font-medium transition-all sm:inline-block"
            style={{
              boxShadow: dark
                ? "inset 0 0 0 1px rgba(255,255,255,.2)"
                : "inset 0 0 0 1px var(--th-btn-ghost-bd)",
              color: dark ? "rgba(255,255,255,.8)" : "var(--th-btn-ghost-text)",
            }}
          >
            Download
          </Link>
          <a
            href={CLOUD_HREF}
            className="hidden rounded-full px-5 py-2 text-[14px] font-medium transition-all sm:inline-block"
            style={{
              background: dark ? "#fff" : "var(--th-btn-bg)",
              color: dark ? "#000" : "var(--th-btn-text)",
            }}
          >
            Start on Cloud
          </a>

          {/* ── Hamburger (mobile only) ──────────────────────── */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full xl:hidden"
            style={{ background: dark ? "rgba(255,255,255,.10)" : "var(--th-sf-04)" }}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke={dark ? "#fff" : "var(--th-text-heading)"}
              strokeWidth={2}
            >
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
        <div className="fixed inset-0 z-40 xl:hidden" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <nav className="absolute right-0 top-0 flex h-full w-[280px] flex-col gap-1 overflow-y-auto bg-[var(--th-bg-page)] px-6 pb-8 pt-24 shadow-2xl">
            {NAV.map((entry) =>
              isGroup(entry) ? (
                <div key={entry.label} className="mt-2">
                  <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--th-text-muted)]">
                    {entry.label}
                  </p>
                  {entry.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className="block rounded-xl px-4 py-3 text-[15px] font-medium th-text-body transition-colors hover:bg-[var(--th-sf-04)]"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              ) : (
                <Link
                  key={entry.label}
                  href={entry.href}
                  onClick={() => setMobileOpen(false)}
                  className="rounded-xl px-4 py-3 text-[15px] font-medium th-text-body transition-colors hover:bg-[var(--th-sf-04)]"
                >
                  {entry.label}
                </Link>
              ),
            )}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={githubDescription}
              title={githubDescription}
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2 rounded-xl px-4 py-3 text-[15px] font-medium th-text-body transition-colors hover:bg-[var(--th-sf-04)]"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <path d={GITHUB_PATH} />
              </svg>
              {githubLabel}
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
              className="mt-1 rounded-xl border border-[var(--th-btn-ghost-bd)] px-4 py-3 text-center text-[15px] font-medium th-text-body"
            >
              Download
            </Link>
            <a
              href={CLOUD_HREF}
              onClick={() => setMobileOpen(false)}
              className="mt-1 rounded-xl bg-[var(--th-btn-bg)] px-4 py-3 text-center text-[15px] font-medium text-[var(--th-btn-text)]"
            >
              Start on Cloud
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
