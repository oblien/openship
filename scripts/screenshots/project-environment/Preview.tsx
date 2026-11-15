"use client";

import { useSearchParams } from "next/navigation";
import { PlatformProvider } from "@/context/PlatformContext";
import { CloudProvider } from "@/context/CloudContext";
import { GitHubProvider } from "@/context/GitHubContext";
import { ProjectSettingsProvider } from "@/context/ProjectSettingsContext";
import { ProjectEnvironmentSettings } from "@/app/(dashboard)/projects/[id]/components/BuildSettings";
import { ServicesTab } from "@/app/(dashboard)/projects/[id]/components/ServicesTab";
import { Logo } from "@/components/logo";
import { useI18n } from "@/components/i18n-provider";

export const project = {
  id: "environment-preview",
  name: "website",
  slug: "website",
  description: "",
  framework: "nextjs",
  activeDeploymentId: "live-preview",
  status: "ready",
  runtimeMode: "bare" as const,
  deployTarget: "server" as const,
  options: { workloadType: "web", hasServer: true },
};

/** Real project components; the capture script supplies synthetic API responses. */
export default function Preview() {
  const { t } = useI18n();
  const query = useSearchParams();
  const view = query.get("view") ?? "services";
  const kind = query.get("kind");
  const current = {
    ...project,
    ...(kind === "static" ? { options: { workloadType: "static", hasServer: false } } : {}),
    ...(kind === "cloud" ? { deployTarget: "cloud" as const } : {}),
  };
  return (
    <PlatformProvider selfHosted deployMode="server" authMode="none">
      <GitHubProvider>
        <CloudProvider>
          <ProjectSettingsProvider
            id={project.id}
            initialProjectData={current}
            slug={view === "application" ? ["services", "application", "env"] : [view]}
          >
              <main data-environment-capture className="min-h-screen bg-background text-foreground">
              <div className="mx-auto max-w-5xl px-5 py-8 space-y-7">
                <header className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 font-medium">
                    <Logo size={28} /> Openship
                  </div>
                  <span className="text-xs text-muted-foreground">Preview · sample project</span>
                </header>
                <div>
                  <p className="text-sm text-muted-foreground mb-2">website / Production</p>
                  <h1 className="text-2xl font-medium">
                    {view === "settings"
                      ? t.projects.sidebar.tabs.advanced
                      : t.projects.sidebar.tabs.services}
                  </h1>
                </div>
                {view === "settings" ? <ProjectEnvironmentSettings /> : <ServicesTab />}
              </div>
            </main>
          </ProjectSettingsProvider>
        </CloudProvider>
      </GitHubProvider>
    </PlatformProvider>
  );
}
