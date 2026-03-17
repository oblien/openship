import { redirect } from "next/navigation";
import { getSession, getDeploymentInfo } from "@/lib/server/session";
import { Sidebar } from "@/components/sidebar";
import { DashboardProviders } from "./providers";

/**
 * Dashboard shell layout — sidebar + main area.
 * Session is validated server-side before rendering.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const deploymentInfo = await getDeploymentInfo();

  return (
    <DashboardProviders selfHosted={deploymentInfo.selfHosted} deployMode={deploymentInfo.deployMode} authMode={deploymentInfo.authMode} cloudAuthUrl={deploymentInfo.cloudAuthUrl} machineName={deploymentInfo.machineName}>
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
