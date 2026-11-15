"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { ArrowRight, ArrowUpRight, Download } from "lucide-react";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { reportCaughtError } from "@repo/core/diagnostics";
import { useCopy } from "@/i18n/use-copy";
import { Link } from "@/i18n/Link";
import { usePlatform, type Platform } from "@/hooks/use-platform";
import { DEPLOY_SCREEN_SIZE, localizedScreenshot } from "@/lib/marketing-screenshots";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { PlatformIcon } from "@/components/platform-icon";
import { InstallTabs } from "@/components/install-tabs";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { MarketingSection } from "@/components/marketing/marketing-section";
import "./download.css";

const DESKTOP_DETAILS: Record<Exclude<Platform, "unknown">, { title: string; variant: string; format: string }> = {
  "mac-arm": { title: "macOS", variant: "Apple Silicon", format: "DMG" },
  "mac-intel": { title: "macOS", variant: "Intel x86_64", format: "DMG" },
  windows: { title: "Windows", variant: "64-bit", format: "ZIP" },
  linux: { title: "Linux", variant: "x86_64", format: "AppImage" },
};

type Release = { version: string; sizes: Record<string, number> };

export default function DownloadPage() {
  const copy = useCopy();
  const locale = useLocale();
  const { platform, label, icon, downloadUrl, allPlatforms, getDownloadUrl } = usePlatform();
  const [release, setRelease] = useState<Release | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Labels are optional: release links keep working when GitHub is unavailable.
    async function loadRelease() {
      try {
        const response = await fetch("https://api.github.com/repos/oblien/openship/releases/latest", {
          headers: { Accept: "application/vnd.github+json" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        const sizes: Record<string, number> = {};
        for (const asset of Array.isArray(data.assets) ? data.assets : []) {
          if (typeof asset.name === "string" && typeof asset.size === "number" && asset.size > 0) {
            sizes[asset.name] = asset.size;
          }
        }
        if (!controller.signal.aborted) {
          setRelease({ version: typeof data.tag_name === "string" ? data.tag_name : "", sizes });
        }
      } catch (error) {
        if (!controller.signal.aborted) reportCaughtError(error, "web/download/release");
      }
    }
    void loadRelease();
    return () => controller.abort();
  }, []);

  return (
    <>
      <Navbar />
      <main className="dl-page marketing-page">
        <section className="dl-hero hero-section" aria-labelledby="download-title">
          <div className="hero-grain absolute inset-0" aria-hidden="true" />
          <div className="hero-grid absolute inset-0" aria-hidden="true" />
          <div className="hero-aurora" aria-hidden="true">
            <div className="hero-aurora-core" />
            <div className="hero-aurora-wing hero-aurora-wing--left" />
            <div className="hero-aurora-wing hero-aurora-wing--right" />
          </div>
          <div className="site-container dl-hero-content">
            <FeatureIllustration name="dashboard-cli-desktop" className="marketing-illustration dl-hero-art" />
            <h1 id="download-title" className="dl-title">
              {copy("Install OpenShip.")}
              <span className="hero-headline-second">{copy("Deploy in seconds.")}</span>
            </h1>
            <p className="dl-hero-description">
              {copy("Your machine, your servers, your stack. The CLI, the dashboard, and the desktop app - all open‑source, all yours to run.")}
            </p>
            <div className="dl-hero-actions">
              <a href={platform === "unknown" ? "#downloads" : downloadUrl} className="th-btn dl-primary">
                <PlatformIcon name={icon} className="dl-button-icon" />
                {copy(label)}
              </a>
              <a href="#cli" className="marketing-text-link">
                {copy("Install the CLI")} <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
            <p className="dl-release">
              <span>{copy("Free forever · Apache 2.0")}</span>
              {release?.version && <bdi>{release.version}</bdi>}
            </p>
          </div>
          <div className="hero-edge-fade-top absolute top-0 inset-x-0 h-20" aria-hidden="true" />
          <div className="hero-edge-fade-bottom absolute bottom-0 inset-x-0 h-40" aria-hidden="true" />
        </section>

        <div className="site-container">
          <figure className="dl-showcase">
            <div className="dl-shot">
              <Image
                src={localizedScreenshot("/screen.png", locale)}
                alt={copy("The OpenShip desktop app - deployments, logs, and services in one native window")}
                {...DEPLOY_SCREEN_SIZE}
                sizes="(max-width: 768px) 92vw, 86vw"
                priority
              />
            </div>
            <figcaption>{copy("The full dashboard, in a native window - deploys, logs, metrics, and services.")}</figcaption>
          </figure>

          <section id="downloads" className="dl-downloads" aria-labelledby="desktop-title">
            <header className="dl-section-head">
              <div>
                <h2 id="desktop-title">{copy("Choose your platform.")}</h2>
                <p>{copy("The desktop app for Mac, Windows, and Linux.")}</p>
              </div>
              <a href="https://github.com/oblien/openship/releases" target="_blank" rel="noopener noreferrer" className="marketing-text-link">
                {copy("All releases")} <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </header>
            <div className="dl-platforms">
              {allPlatforms.map((item) => {
                if (item.platform === "unknown") return null;
                const details = DESKTOP_DETAILS[item.platform];
                const recommended = platform === item.platform;
                const bytes = release?.sizes[item.fileName];
                return (
                  <article key={item.platform} className="dl-platform" data-recommended={recommended}>
                    <div className="dl-platform-mark">
                      <PlatformIcon name={item.icon} className="dl-os-icon" />
                      {recommended && <span className="dl-recommended">{copy("Recommended")}</span>}
                    </div>
                    <h3>{details.title}</h3>
                    <p className="dl-platform-variant">{copy(details.variant)}</p>
                    <div className="dl-platform-meta">
                      <bdi>{details.format}</bdi>
                      {bytes && <bdi>{new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_000_000)}</bdi>}
                    </div>
                    <a
                      href={getDownloadUrl(item.platform)}
                      className={`dl-platform-download ${recommended ? "th-btn" : "th-btn-ghost"}`}
                      aria-label={`${copy(item.label)} (${copy(details.variant)})`}
                    >
                      {copy("Download")} <Download size={16} aria-hidden="true" />
                    </a>
                  </article>
                );
              })}
            </div>
            <Link href="/docs/getting-started/installation" className="dl-install-help marketing-text-link">
              {copy("Installation guide")} <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </section>

          <section id="cli" className="dl-cli" aria-labelledby="cli-title">
            <div className="dl-cli-copy">
              <FeatureIllustration name="api-sdk" className="marketing-illustration" />
              <h2 id="cli-title">{copy("One command.")} <span>{copy("Any shell, any OS.")}</span></h2>
              <p>{copy("Install the CLI to deploy, view logs, and manage your projects from the terminal.")}</p>
              <Link href="/docs/cli" className="marketing-text-link">
                {copy("Full CLI reference")} <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
            <div className="dl-cli-install">
              <InstallTabs
                includePackageManagers
                labels={{
                  methods: copy("Install method"),
                  copy: copy("Copy install command"),
                  copied: copy("Copied!"),
                  error: copy("Could not copy. Select the command to copy it."),
                }}
              />
              <div className="dl-cli-next">
                <span>{copy("Then open your dashboard.")}</span>
                <code>openship up</code>
              </div>
            </div>
          </section>

          <MarketingSection id="getting-started" title="Your next step" description="Start locally, then choose where your apps run.">
            <div className="marketing-grid">
              <IllustratedLink
                href="/docs/getting-started/first-deployment"
                illustration="push-to-deploy"
                title="Deploy your first app"
                description="Connect a repository and follow your first deployment."
              />
              <IllustratedLink
                href="/docs/getting-started/installation"
                illustration="server-management"
                title="Run on your own server"
                description="Set up OpenShip on a server with Docker or the CLI."
              />
            </div>
          </MarketingSection>
        </div>
      </main>
      <Footer />
    </>
  );
}
