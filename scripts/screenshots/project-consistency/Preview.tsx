"use client";
import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { PlatformProvider } from "@/context/PlatformContext";
import { CloudProvider } from "@/context/CloudContext";
import { GitHubProvider } from "@/context/GitHubContext";
import { ProjectSettingsProvider } from "@/context/ProjectSettingsContext";
import { ServicesTab } from "@/app/(dashboard)/projects/[id]/components/ServicesTab";
import { BuildSettings } from "@/app/(dashboard)/projects/[id]/components/BuildSettings";
import { DomainSettings } from "@/app/(dashboard)/projects/[id]/components/DomainSettings";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { useTheme } from "@/components/theme-provider";
const project = {
  id: "environment-preview",
  name: "website",
  slug: "website",
  description: "",
  framework: "nextjs",
  activeDeploymentId: "live-preview",
  status: "ready",
  runtimeMode: "bare" as const,
  deployTarget: "server" as const,
  port: 3000,
  gitOwner: "example",
  gitRepo: "website",
  options: {
    workloadType: "web",
    hasServer: true,
    hasBuild: true,
    buildCommand: "bun run build",
    startCommand: "bun run start",
    productionPort: 3000,
  },
};
export default function Preview() {
  const pathname = usePathname();
  const slug = pathname.split("/").slice(3);
  const settings = slug[0] === "advanced";
  const domains = slug[0] === "domains";
  const services = !slug[0] || slug[0] === "services";
  const { t } = useI18n();
  const { setTheme } = useTheme();
  const [loading, setLoading] = useState(false);
  async function scenario(services: boolean) {
    setLoading(true);
    await fetch("http://127.0.0.1:3013/api/preview/scenario", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services }),
    });
    window.location.href = "/projects/environment-preview/services";
  }
  return (
    <PlatformProvider selfHosted deployMode="server" authMode="none">
      <GitHubProvider>
        <CloudProvider>
          <ProjectSettingsProvider id={project.id} initialProjectData={project} slug={slug}>
            <main data-consistency-preview className="min-h-screen bg-background text-foreground">
              <div className="border-b border-border/40 bg-card px-5 py-3">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Interactive preview · sample data · no live deployments</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={loading}
                      onClick={() => void scenario(false)}
                    >
                      Single app
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={loading}
                      onClick={() => void scenario(true)}
                    >
                      Add PostgreSQL
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTheme("light")}>
                      Light
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTheme("dark")}>
                      Dark
                    </Button>
                  </div>
                </div>
              </div>
              <div className="mx-auto max-w-6xl space-y-7 px-5 py-8">
                <header className="flex items-center justify-between">
                  <Link
                    href="/projects/environment-preview/services"
                    className="flex items-center gap-3 font-medium"
                  >
                    <Logo size={28} /> Openship
                  </Link>
                  <span className="text-xs text-muted-foreground">website / Production</span>
                </header>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-2xl font-medium">
                    {settings
                      ? t.projects.sidebar.tabs.settings
                      : domains
                        ? t.projects.sidebar.tabs.domains
                        : t.projects.sidebar.tabs.services}
                  </h1>
                  <nav className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant={settings ? "ghost" : "secondary"}>
                      <Link href="/projects/environment-preview/services">
                        {t.projects.sidebar.tabs.services}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant={domains ? "secondary" : "ghost"}>
                      <Link href="/projects/environment-preview/domains">
                        {t.projects.sidebar.tabs.domains}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant={settings ? "secondary" : "ghost"}>
                      <Link href="/projects/environment-preview/advanced">
                        {t.projects.sidebar.tabs.settings}
                      </Link>
                    </Button>
                  </nav>
                </div>
                {settings ? (
                  <BuildSettings />
                ) : domains ? (
                  <DomainSettings />
                ) : services ? (
                  <ServicesTab />
                ) : (
                  <section className="space-y-3 rounded-2xl bg-card p-6">
                    <h2 className="text-base font-medium">Outside this preview</h2>
                    <p className="text-sm text-muted-foreground">
                      This sample covers Apps &amp; Services, environment changes, and project
                      Settings. Deployment history and topology use their existing dashboard
                      screens.
                    </p>
                    <Button asChild size="sm" variant="secondary">
                      <Link href="/projects/environment-preview/services">
                        Return to Apps &amp; Services
                      </Link>
                    </Button>
                  </section>
                )}
              </div>
            </main>
          </ProjectSettingsProvider>
        </CloudProvider>
      </GitHubProvider>
    </PlatformProvider>
  );
}
