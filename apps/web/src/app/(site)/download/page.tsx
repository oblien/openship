"use client";

import Link from "next/link";
import { useState } from "react";
import { usePlatform, type Platform } from "@/hooks/use-platform";
import { Navbar, Footer } from "@/components/landing";
import "./download.css";

/* ── Platform glyphs ──────────────────────────────────────────── */
function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}
function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}
function LinuxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.868.07 1.678-.467 1.975-1.484.1-.334.204-.669.305-1.004.2-.668.398-1.335.554-2 .156-.668.297-1.338.378-2.004a2.08 2.08 0 00-.193-1.2c.4-.748.757-1.336.914-2.007.199-.869.099-1.87-.399-3.003-.564-1.332-1.272-2.8-1.743-4.287-.216-.668-.39-1.314-.428-2.008-.05-.87.154-1.868.473-2.865.32-.998.721-2.093.66-3.202C18.108.784 16.985 0 15.595 0h-.003c-.578.002-1.129.2-1.597.468a4.534 4.534 0 00-1.482 1.196c-.012.016-.018.019-.03.019z" />
    </svg>
  );
}

type DownloadEntry = {
  platform: Platform;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  fileName: string;
  size: string;
};

const DOWNLOADS: DownloadEntry[] = [
  { platform: "mac-arm",   title: "macOS",   subtitle: "Apple Silicon (M1–M4)", icon: AppleIcon,   fileName: "Openship-arm64.dmg",   size: "84 MB" },
  { platform: "mac-intel", title: "macOS",   subtitle: "Intel x86_64",          icon: AppleIcon,   fileName: "Openship-x64.dmg",     size: "92 MB" },
  { platform: "windows",   title: "Windows", subtitle: "Windows 10/11 · 64-bit", icon: WindowsIcon, fileName: "Openship-Setup.exe",   size: "76 MB" },
  { platform: "linux",     title: "Linux",   subtitle: "AppImage · x86_64",     icon: LinuxIcon,   fileName: "Openship.AppImage",    size: "98 MB" },
];

const DOWNLOAD_BASE = "https://github.com/oblien/openship/releases/latest/download";

const CLI_OPTIONS = [
  { manager: "npm",  cmd: "npm i -g openship" },
  { manager: "pnpm", cmd: "pnpm add -g openship" },
  { manager: "yarn", cmd: "yarn global add openship" },
  { manager: "bun",  cmd: "bun add -g openship" },
];

const STEPS = [
  { num: "01", title: "Install", desc: "One command in any package manager. No daemons, no agents." },
  { num: "02", title: "Connect", desc: "Run openship init and point it at your server over SSH." },
  { num: "03", title: "Ship",    desc: "Run openship deploy. TLS, DNS, databases, edge - done." },
];

const MODES = [
  {
    label: "CLI",
    tag: "Terminal",
    desc: "Install once, deploy from any shell. Stream logs, roll back, manage domains - without leaving your editor.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    label: "Web Dashboard",
    tag: "Self-hosted",
    desc: "Bring up the full dashboard on your own box. Team access, CI/CD, monitoring, audit logs.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6h16.5M3.75 12h16.5M3.75 18h16.5" />
      </svg>
    ),
  },
  {
    label: "Desktop App",
    tag: "Native",
    desc: "macOS, Windows, Linux. Connect servers, deploy, monitor - visual workflows in a single window.",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
      </svg>
    ),
  },
];

export default function DownloadPage() {
  const { platform: detected } = usePlatform();
  const [downloading, setDownloading] = useState<Platform | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeManager, setActiveManager] = useState<string>("npm");

  const handleDownload = (platform: Platform, fileName: string) => {
    setDownloading(platform);
    window.location.href = `${DOWNLOAD_BASE}/${fileName}`;
    setTimeout(() => setDownloading(null), 3000);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1800);
  };

  const activeCmd = CLI_OPTIONS.find((o) => o.manager === activeManager)?.cmd ?? CLI_OPTIONS[0].cmd;
  const recommendedDl = DOWNLOADS.find((d) => d.platform === detected) ?? DOWNLOADS[0];

  return (
    <>
      <Navbar />

      {/* ════════════════════════════════════════════════════════════
          HERO - landing-grade structure, distinct seafoam/cyan palette
      ════════════════════════════════════════════════════════════ */}
      <section className="dl-hero hero-section relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden">
        <div className="hero-grain absolute inset-0" aria-hidden="true" />
        <div className="hero-grid absolute inset-0" aria-hidden="true" />

        {/* Bottom aurora glow */}
        <div className="hero-aurora" aria-hidden="true">
          <div className="hero-aurora-core" />
          <div className="hero-aurora-wing hero-aurora-wing--left" />
          <div className="hero-aurora-wing hero-aurora-wing--right" />
        </div>

        <div className="relative z-20 mx-auto w-full max-w-[860px] px-6 text-center">
          {/* Install command pill */}
          <button
            onClick={() => handleCopy(activeCmd)}
            className="animate-fade-in-up group mb-7 inline-flex items-center gap-2 font-mono text-[13px] tracking-[0.01em] th-text-muted transition-colors hover:th-text-secondary"
          >
            <span className="opacity-50">$</span>
            <span>{activeCmd}</span>
            <span className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-50">
              {copied === activeCmd ? (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                </svg>
              )}
            </span>
          </button>

          {/* Two-line headline */}
          <h1 className="animate-fade-in-up animate-delay-100">
            <span className="block text-[clamp(2.5rem,5.5vw,4.25rem)] font-medium leading-[1.08] tracking-[-0.02em] th-text-heading">
              Install Openship.
            </span>
            <span className="hero-headline-second block text-[clamp(2.5rem,5.5vw,4.25rem)] font-light italic leading-[1.08] tracking-[-0.015em]">
              Deploy in seconds.
            </span>
          </h1>

          {/* Sub */}
          <p className="animate-fade-in-up animate-delay-200 mx-auto mt-6 max-w-[540px] text-[16px] leading-[1.65] th-text-body">
            Your machine, your servers, your stack. The CLI, the dashboard, and the desktop
            app - all open&#8209;source, all yours to run.
          </p>

          {/* CTAs */}
          <div className="animate-fade-in-up animate-delay-300 mt-9 flex flex-col items-center gap-5">
            <div className="flex items-center justify-center gap-3.5">
              <button
                onClick={() => handleDownload(recommendedDl.platform, recommendedDl.fileName)}
                className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
              >
                <svg className="-ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download for {recommendedDl.title}
                <svg className="ml-1.5 -mr-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </button>
              <a
                href="https://github.com/oblien/openship"
                target="_blank"
                rel="noopener noreferrer"
                className="th-btn-ghost group rounded-full px-7 py-3 text-[15px] font-medium"
              >
                <svg className="-ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                View on GitHub
              </a>
            </div>
            <p className="text-[12px] th-text-muted">
              Free forever · AGPL-3.0 · v1.0
            </p>
          </div>
        </div>

        {/* Edge fades - top covers navbar gap, bottom blends into the next section */}
        <div className="hero-edge-fade-top absolute top-0 left-0 right-0 h-20" aria-hidden="true" />
        <div className="hero-edge-fade-bottom absolute bottom-0 left-0 right-0 h-40" aria-hidden="true" />
      </section>

      <main className="relative">
        {/* ════════════════════════════════════════════════════════════
            PRODUCT SHOWCASE - the app itself, tucked up under the hero
        ════════════════════════════════════════════════════════════ */}
        <section className="relative z-10 mx-auto -mt-16 max-w-6xl px-6 sm:-mt-24">
          <div className="dl-shot">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screen.png"
              alt="The Openship desktop app - deployments, logs, and services in one native window"
              width={2880}
              height={1800}
              loading="lazy"
              decoding="async"
            />
          </div>
          <p className="mt-5 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            The full dashboard, in a native window - deploys, logs, metrics, and services.
          </p>
        </section>

        {/* ════════════════════════════════════════════════════════════
            CLI INSTALL - editorial spread with manager tabs
        ════════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
          <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr]">
            {/* Left - copy */}
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--th-text-muted)" }}>
                The CLI · /docs/cli
              </p>
              <h2 className="mt-4 text-[clamp(1.875rem,3.6vw,2.625rem)] font-medium leading-[1.1] tracking-[-0.025em]" style={{ color: "var(--th-text-heading)" }}>
                One command.<br />
                <span className="font-light italic" style={{ color: "var(--th-on-40)" }}>
                  Any package manager.
                </span>
              </h2>
              <p className="mt-5 max-w-md text-[16px] leading-[1.65]" style={{ color: "var(--th-text-body)" }}>
                Install globally and you&rsquo;re ready. Same binary on every OS.
                No daemons. No background services. No mystery.
              </p>
              <Link
                href="/docs/cli"
                className="mt-7 inline-flex items-center gap-1.5 text-[14px] font-medium"
                style={{ color: "var(--th-text-heading)" }}
              >
                Full CLI reference
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
            </div>

            {/* Right - terminal card */}
            <div
              className="overflow-hidden rounded-2xl"
              style={{
                background: "var(--th-card-bg)",
                border: "1px solid var(--th-card-bd)",
                boxShadow: "0 1px 0 0 var(--th-on-05), 0 24px 60px -32px rgba(0,0,0,.16)",
              }}
            >
              {/* Window chrome */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{
                  borderBottom: "1px solid var(--th-card-bd)",
                  background: "var(--th-sf-02)",
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
                </div>
                <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--th-text-muted)" }}>
                  ~ / install
                </span>
                <div className="w-10" />
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-0.5 px-4 pt-3">
                {CLI_OPTIONS.map((opt) => {
                  const active = opt.manager === activeManager;
                  return (
                    <button
                      key={opt.manager}
                      onClick={() => setActiveManager(opt.manager)}
                      className="rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors"
                      style={{
                        background: active ? "var(--th-sf-05)" : "transparent",
                        color: active ? "var(--th-text-heading)" : "var(--th-text-muted)",
                      }}
                    >
                      {opt.manager}
                    </button>
                  );
                })}
              </div>

              {/* Command + copy */}
              <button
                onClick={() => handleCopy(activeCmd)}
                className="group flex w-full items-center justify-between px-5 py-5 text-left transition-colors hover:bg-[var(--th-sf-02)]"
              >
                <div className="flex min-w-0 items-center gap-3 font-mono text-[15px]">
                  <span style={{ color: "var(--th-clr-sea)" }}>$</span>
                  <span className="truncate" style={{ color: "var(--th-text-heading)" }}>{activeCmd}</span>
                </div>
                <span
                  className="ml-3 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] transition-colors"
                  style={{
                    background: copied === activeCmd ? "var(--th-clr-sea-bg)" : "var(--th-sf-04)",
                    color: copied === activeCmd ? "var(--th-clr-sea)" : "var(--th-text-muted)",
                    border: copied === activeCmd ? "1px solid var(--th-clr-sea-bdr)" : "1px solid var(--th-on-06)",
                  }}
                >
                  {copied === activeCmd ? (
                    <>
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.6}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      Copied
                    </>
                  ) : (
                    <>
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                      </svg>
                      Copy
                    </>
                  )}
                </span>
              </button>

              {/* Result preview line */}
              <div
                className="border-t px-5 py-3.5 font-mono text-[12px]"
                style={{
                  borderColor: "var(--th-card-bd)",
                  background: "var(--th-sf-01)",
                  color: "var(--th-text-muted)",
                }}
              >
                + openship@1.0.0 installed in 4.2s &nbsp;·&nbsp; <span style={{ color: "var(--th-clr-sea)" }}>ready</span>
              </div>
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════
            DIVIDER
        ════════════════════════════════════════════════════════════ */}
        <div className="section-divider mx-auto max-w-6xl" />

        {/* ════════════════════════════════════════════════════════════
            DESKTOP DOWNLOADS - featured primary + compact secondary row
        ════════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--th-text-muted)" }}>
              Desktop App
            </p>
            <h2 className="mt-4 text-[clamp(2rem,4vw,2.875rem)] font-medium leading-[1.08] tracking-[-0.025em]" style={{ color: "var(--th-text-heading)" }}>
              Native everywhere.
              <span className="block font-light italic" style={{ color: "var(--th-on-40)" }}>
                Signed and notarized.
              </span>
            </h2>
            <p className="mx-auto mt-5 max-w-md text-[16px] leading-[1.6]" style={{ color: "var(--th-text-body)" }}>
              Same Openship in a polished desktop window. Auto-updates across every
              platform, ready out of the box.
            </p>
          </div>

          {/* ── Featured card - detected platform ─────────────────── */}
          {(() => {
            const PrimaryIcon = recommendedDl.icon;
            const isDl = downloading === recommendedDl.platform;
            return (
              <div
                className="mx-auto mt-14 max-w-3xl overflow-hidden rounded-3xl"
                style={{
                  background: "var(--th-card-bg)",
                  border: "1px solid var(--th-card-bd)",
                  boxShadow: "0 1px 0 0 var(--th-on-05), 0 30px 80px -40px rgba(0,0,0,.18)",
                }}
              >
                <div className="flex flex-col gap-8 p-9 sm:flex-row sm:items-center sm:gap-10 sm:p-11">
                  {/* Glyph */}
                  <div className="flex shrink-0 items-center justify-center">
                    <div
                      className="flex h-24 w-24 items-center justify-center rounded-3xl"
                      style={{
                        background: "var(--th-sf-04)",
                        border: "1px solid var(--th-on-06)",
                      }}
                    >
                      <PrimaryIcon className="h-12 w-12" />
                    </div>
                  </div>

                  {/* Copy + CTA */}
                  <div className="min-w-0 flex-1">
                    <div className="text-[26px] font-medium tracking-[-0.02em]" style={{ color: "var(--th-text-heading)" }}>
                      {recommendedDl.title}
                    </div>
                    <div className="mt-1 text-[14px]" style={{ color: "var(--th-text-muted)" }}>
                      {recommendedDl.subtitle}
                    </div>

                    <div className="mt-7 flex flex-wrap items-center gap-3">
                      <button
                        onClick={() => handleDownload(recommendedDl.platform, recommendedDl.fileName)}
                        className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
                      >
                        <svg className="-ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                        </svg>
                        {isDl ? "Downloading…" : `Download ${recommendedDl.fileName}`}
                      </button>
                      <span className="font-mono text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {recommendedDl.size}
                      </span>
                    </div>

                    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                      <span className="inline-flex items-center gap-1.5">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} style={{ color: "var(--th-clr-sea)" }}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Signed &amp; notarized
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                        </svg>
                        Auto-updating
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        v1.0.0 · today
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── Other platforms - compact row ─────────────────────── */}
          <div className="mx-auto mt-8 max-w-3xl">
            <p className="mb-4 text-[12px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--th-text-muted)" }}>
              Other platforms
            </p>
            <div className="grid gap-px overflow-hidden rounded-2xl sm:grid-cols-3"
              style={{
                background: "var(--th-card-bd)",
                border: "1px solid var(--th-card-bd)",
                boxShadow: "0 1px 0 0 var(--th-on-05)",
              }}
            >
              {DOWNLOADS.filter((dl) => dl.platform !== recommendedDl.platform).map((dl) => {
                const Icon = dl.icon;
                const isDl = downloading === dl.platform;
                return (
                  <button
                    key={dl.platform}
                    onClick={() => handleDownload(dl.platform, dl.fileName)}
                    className="group flex items-center gap-4 p-5 text-left transition-colors hover:bg-[var(--th-sf-02)]"
                    style={{ background: "var(--th-card-bg)" }}
                  >
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                      style={{
                        background: "var(--th-sf-04)",
                        border: "1px solid var(--th-on-06)",
                      }}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium" style={{ color: "var(--th-text-heading)" }}>
                        {dl.title}
                      </div>
                      <div className="mt-0.5 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {dl.subtitle} · {dl.size}
                      </div>
                    </div>
                    <span
                      className="shrink-0 transition-transform group-hover:translate-y-0.5"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      {isDl ? (
                        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992m-4.992 0L20.015 5.355M2.985 14.652v-.001m0 .001H7.977m-4.992 0l3.992 3.993" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="mt-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            requires macOS 12+, Windows 10+, or Ubuntu 20.04+ ·{" "}
            <a
              href="https://github.com/oblien/openship/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
              style={{ color: "var(--th-text-secondary)", textDecorationColor: "var(--th-on-12)" }}
            >
              all releases &amp; changelog
            </a>
          </p>
        </section>

        {/* ════════════════════════════════════════════════════════════
            DIVIDER
        ════════════════════════════════════════════════════════════ */}
        <div className="section-divider mx-auto max-w-6xl" />

        {/* ════════════════════════════════════════════════════════════
            HOW IT WORKS - editorial 3-row layout, big numerals
        ════════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--th-text-muted)" }}>
              From install to live
            </p>
            <h2 className="mt-4 text-[clamp(2rem,4vw,2.875rem)] font-medium leading-[1.08] tracking-[-0.025em]" style={{ color: "var(--th-text-heading)" }}>
              Three commands.
              <span className="block font-light italic" style={{ color: "var(--th-on-40)" }}>
                Zero config.
              </span>
            </h2>
          </div>

          <div className="mt-16 mx-auto max-w-3xl space-y-0">
            {STEPS.map((step, i) => (
              <div
                key={step.num}
                className="grid items-baseline gap-8 py-10 sm:grid-cols-[120px_1fr]"
                style={{
                  borderTop: i === 0 ? "1px solid var(--th-bd-subtle)" : "none",
                  borderBottom: "1px solid var(--th-bd-subtle)",
                }}
              >
                <div className="font-mono text-[13px] tracking-[0.08em]" style={{ color: "var(--th-text-muted)" }}>
                  STEP · {step.num}
                </div>
                <div>
                  <h3 className="text-[clamp(1.25rem,2vw,1.5rem)] font-medium tracking-[-0.015em]" style={{ color: "var(--th-text-heading)" }}>
                    {step.title}
                  </h3>
                  <p className="mt-3 max-w-lg text-[15px] leading-[1.6]" style={{ color: "var(--th-text-body)" }}>
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════
            DIVIDER
        ════════════════════════════════════════════════════════════ */}
        <div className="section-divider mx-auto max-w-6xl" />

        {/* ════════════════════════════════════════════════════════════
            THREE WAYS TO DEPLOY
        ════════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--th-text-muted)" }}>
              Pick your surface
            </p>
            <h2 className="mt-4 text-[clamp(2rem,4vw,2.875rem)] font-medium leading-[1.08] tracking-[-0.025em]" style={{ color: "var(--th-text-heading)" }}>
              Three ways to deploy.
              <span className="block font-light italic" style={{ color: "var(--th-on-40)" }}>
                Same engine underneath.
              </span>
            </h2>
          </div>

          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl lg:grid-cols-3"
            style={{
              background: "var(--th-card-bd)",
              border: "1px solid var(--th-card-bd)",
              boxShadow: "0 1px 0 0 var(--th-on-05)",
            }}
          >
            {MODES.map((mode) => (
              <div
                key={mode.label}
                className="p-9"
                style={{ background: "var(--th-card-bg)" }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-lg"
                    style={{ background: "var(--th-sf-04)", color: "var(--th-text-heading)" }}
                  >
                    {mode.icon}
                  </div>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--th-text-muted)" }}>
                    {mode.tag}
                  </span>
                </div>
                <h3 className="mt-6 text-[18px] font-medium tracking-[-0.01em]" style={{ color: "var(--th-text-heading)" }}>
                  {mode.label}
                </h3>
                <p className="mt-2 text-[14.5px] leading-[1.65]" style={{ color: "var(--th-text-body)" }}>
                  {mode.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════
            FINAL CTA - editorial outro
        ════════════════════════════════════════════════════════════ */}
        <section className="mx-auto max-w-6xl px-6 pb-32 pt-8 sm:pb-40">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-[clamp(2rem,4vw,2.875rem)] font-medium leading-[1.08] tracking-[-0.025em]" style={{ color: "var(--th-text-heading)" }}>
              Ready in 60 seconds.
            </h2>
            <p className="mx-auto mt-5 max-w-md text-[16px] leading-[1.6]" style={{ color: "var(--th-text-body)" }}>
              Install the CLI and ship your first deploy. Free, open-source, AGPL-3.0.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
              <button
                onClick={() => handleCopy("npm i -g openship")}
                className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
              >
                <span className="font-mono opacity-60">$</span>
                npm i -g openship
                <span className="ml-1.5 text-[11px] uppercase tracking-[0.08em] opacity-50">
                  {copied === "npm i -g openship" ? "copied" : "copy"}
                </span>
              </button>
              <Link href="/docs" className="th-btn-ghost group rounded-full px-7 py-3 text-[15px] font-medium">
                Read the docs
                <svg className="ml-1.5 -mr-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
