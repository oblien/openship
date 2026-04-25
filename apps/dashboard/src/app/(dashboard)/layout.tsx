import { redirect } from "next/navigation";
import { getSession, getDeploymentInfo } from "@/lib/server/session";
import { Sidebar } from "@/components/sidebar";
import { DashboardProviders } from "./providers";
import { serverApi } from "@/lib/server/api";

/**
 * Dashboard shell layout — sidebar + main area.
 * Session is validated server-side before rendering.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const [deploymentInfo, initialGithubData] = await Promise.all([
    getDeploymentInfo(),
    serverApi.get("/api/github/home", { cache: "no-store" }).catch(() => null)
  ]);

  return (
    <DashboardProviders
      initialGithubData={initialGithubData}
      initialUser={session.user}
      selfHosted={deploymentInfo.selfHosted}
      deployMode={deploymentInfo.deployMode}
      authMode={deploymentInfo.authMode}
      cloudAuthUrl={deploymentInfo.cloudAuthUrl}
      machineName={deploymentInfo.machineName}
      hostDomain={deploymentInfo.hostDomain}
    >
      <div className="flex h-dvh">
        <Sidebar />
        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </DashboardProviders>
  );
}
