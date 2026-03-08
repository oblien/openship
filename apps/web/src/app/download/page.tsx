"use client";

import Link from "next/link";
import { usePlatform, type Platform } from "@/hooks/use-platform";
import { useState } from "react";

/* ── Platform icons (same as download-button) ── */
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

const DOWNLOADS: {
  platform: Platform;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  fileName: string;
}[] = [
  {
    platform: "mac-arm",
    title: "macOS",
    subtitle: "Apple Silicon (M1/M2/M3/M4)",
    icon: AppleIcon,
    fileName: "Openship-arm64.dmg",
  },
  {
    platform: "mac-intel",
    title: "macOS",
    subtitle: "Intel",
    icon: AppleIcon,
    fileName: "Openship-x64.dmg",
  },
  {
    platform: "windows",
    title: "Windows",
    subtitle: "Windows 10+ (64-bit)",
    icon: WindowsIcon,
    fileName: "Openship-Setup.exe",
  },
  {
    platform: "linux",
    title: "Linux",
    subtitle: "AppImage (x86_64)",
    icon: LinuxIcon,
    fileName: "Openship.AppImage",
  },
];

const DOWNLOAD_BASE =
  "https://github.com/openshiporg/openship/releases/latest/download";

const STEPS = [
  {
    num: "1",
    title: "Download the app",
    desc: "Pick your platform above. Install just like any other app.",
  },
  {
    num: "2",
    title: "Enter your server",
    desc: "Type your server IP and credentials. Openship connects over SSH — no agents to install.",
  },
  {
    num: "3",
    title: "Push to production",
    desc: "Select a project, hit deploy. AI configures everything — TLS, DNS, firewall, databases.",
  },
];

export default function DownloadPage() {
  const { platform: detected } = usePlatform();
  const [downloading, setDownloading] = useState<Platform | null>(null);

  const handleDownload = (platform: Platform, fileName: string) => {
    setDownloading(platform);
    window.location.href = `${DOWNLOAD_BASE}/${fileName}`;
    setTimeout(() => setDownloading(null), 3000);
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--th-bg-page)" }}>
      {/* ── Navbar ── */}
      <header className="sticky top-0 z-50 w-full" style={{ background: "var(--th-bg-page)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div
              className="h-[28px] w-[28px] shrink-0 rounded-full"
              style={{
                borderWidth: "2.5px",
                borderStyle: "solid",
                borderColor: "var(--th-text-heading)",
              }}
            />
            <span
              className="text-[16px] font-semibold tracking-[-0.01em]"
              style={{ color: "var(--th-text-heading)" }}
            >
              Openship
            </span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="/docs"
              className="text-[14px] font-medium transition-colors"
              style={{ color: "var(--th-text-secondary)" }}
            >
              Docs
            </Link>
            <Link
              href="/blog"
              className="text-[14px] font-medium transition-colors"
              style={{ color: "var(--th-text-secondary)" }}
            >
              Blog
            </Link>
            <a
              href="https://github.com/openshiporg/openship"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors"
              style={{ color: "var(--th-text-secondary)" }}
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-28">
        {/* ── Hero ── */}
        <div className="pt-16 pb-4 text-center sm:pt-24">
          <h1
            className="text-[clamp(2.25rem,5vw,3.5rem)] font-semibold leading-[1.1] tracking-[-0.035em]"
            style={{ color: "var(--th-text-heading)" }}
          >
            Download Openship
          </h1>
          <p
            className="mx-auto mt-5 max-w-lg text-[16px] leading-[1.65]"
            style={{ color: "var(--th-text-body)" }}
          >
            One app. Your server. Full production stack in minutes.
            <br />
            Enter your server IP, hit deploy — that&apos;s it.
          </p>
        </div>

        {/* ── Platform cards ── */}
        <div className="mx-auto mt-14 grid max-w-3xl gap-3 sm:grid-cols-2">
          {DOWNLOADS.map((dl) => {
            const isDetected = dl.platform === detected;
            const isDownloading = downloading === dl.platform;
            const Icon = dl.icon;

            return (
              <button
                key={dl.platform}
                onClick={() => handleDownload(dl.platform, dl.fileName)}
                className="group relative flex items-center gap-4 rounded-2xl border p-5 text-left transition-all sm:p-6"
                style={{
                  background: isDetected
                    ? "var(--th-sf-04)"
                    : "var(--th-card-bg)",
                  borderColor: isDetected
                    ? "var(--th-accent-violet)"
                    : "var(--th-card-bd)",
                  boxShadow: isDetected
                    ? "0 0 0 1px var(--th-accent-violet), 0 4px 20px rgba(108,92,231,.1)"
                    : "none",
                }}
              >
                {isDetected && (
                  <span
                    className="absolute -top-2.5 right-4 rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-white"
                    style={{ background: "var(--th-accent-violet)" }}
                  >
                    Recommended
                  </span>
                )}
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    background: "var(--th-sf-04)",
                    border: "1px solid var(--th-on-06)",
                  }}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[15px] font-semibold"
                    style={{ color: "var(--th-text-heading)" }}
                  >
                    {dl.title}
                  </div>
                  <div
                    className="mt-0.5 text-[13px]"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    {dl.subtitle}
                  </div>
                </div>
                <div
                  className="shrink-0 rounded-full px-4 py-2 text-[13px] font-medium transition-all"
                  style={{
                    background: isDetected
                      ? "var(--th-btn-bg)"
                      : "var(--th-sf-04)",
                    color: isDetected
                      ? "var(--th-btn-text)"
                      : "var(--th-text-secondary)",
                    border: isDetected ? "none" : "1px solid var(--th-on-06)",
                  }}
                >
                  {isDownloading ? "Downloading…" : "Download"}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Version + system requirements ── */}
        <div className="mx-auto mt-6 max-w-3xl text-center">
          <p
            className="text-[13px]"
            style={{ color: "var(--th-text-muted)" }}
          >
            v1.0.0 &middot; Requires macOS 12+, Windows 10+, or Ubuntu 20.04+
          </p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            Also available:{" "}
            <Link href="/docs" className="underline underline-offset-2">
              self-hosted server dashboard
            </Link>{" "}
            &middot;{" "}
            <Link href="/docs/cli" className="underline underline-offset-2">
              CLI
            </Link>
          </p>
        </div>

        {/* ── How it works ── */}
        <div className="mx-auto mt-24 max-w-2xl">
          <h2
            className="text-center text-[13px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: "var(--th-text-muted)" }}
          >
            How it works
          </h2>
          <div className="mt-10 flex flex-col gap-10">
            {STEPS.map((step) => (
              <div key={step.num} className="flex gap-5">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[14px] font-bold"
                  style={{
                    background: "var(--th-sf-04)",
                    border: "1px solid var(--th-on-06)",
                    color: "var(--th-accent-violet)",
                  }}
                >
                  {step.num}
                </div>
                <div>
                  <h3
                    className="text-[16px] font-semibold"
                    style={{ color: "var(--th-text-heading)" }}
                  >
                    {step.title}
                  </h3>
                  <p
                    className="mt-1.5 text-[15px] leading-[1.6]"
                    style={{ color: "var(--th-text-body)" }}
                  >
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── 3 deployment modes ── */}
        <div className="mx-auto mt-28 max-w-3xl">
          <h2
            className="text-center text-[clamp(1.5rem,3vw,2rem)] font-semibold tracking-[-0.02em]"
            style={{ color: "var(--th-text-heading)" }}
          >
            Three ways to deploy
          </h2>
          <p
            className="mx-auto mt-3 max-w-md text-center text-[15px] leading-[1.6]"
            style={{ color: "var(--th-text-body)" }}
          >
            Use whatever fits your workflow. Same great experience everywhere.
          </p>

          <div className="mt-12 grid gap-4 sm:grid-cols-3">
            {[
              {
                label: "Desktop App",
                tag: "Killer feature",
                desc: "Download, enter server IP, deploy. From your machine to production — no browser needed.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
                  </svg>
                ),
              },
              {
                label: "Server Dashboard",
                tag: "Self-hosted",
                desc: "Install on your own server. Full web dashboard with team access, CI/CD, and monitoring.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
                  </svg>
                ),
              },
              {
                label: "Openship Cloud",
                tag: "Managed",
                desc: "Don't have a server? Use ours. Same interface, we handle the infrastructure.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
                  </svg>
                ),
              },
            ].map((mode) => (
              <div
                key={mode.label}
                className="rounded-2xl border p-6"
                style={{
                  background: "var(--th-card-bg)",
                  borderColor: "var(--th-card-bd)",
                }}
              >
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    background: "var(--th-sf-04)",
                    color: "var(--th-text-heading)",
                  }}
                >
                  {mode.icon}
                </div>
                <div className="mt-4">
                  <span
                    className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                    style={{ color: "var(--th-accent-violet)" }}
                  >
                    {mode.tag}
                  </span>
                  <h3
                    className="mt-1 text-[16px] font-semibold"
                    style={{ color: "var(--th-text-heading)" }}
                  >
                    {mode.label}
                  </h3>
                  <p
                    className="mt-2 text-[14px] leading-[1.6]"
                    style={{ color: "var(--th-text-body)" }}
                  >
                    {mode.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
