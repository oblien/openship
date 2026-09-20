import { getSession, getDeploymentInfo } from "@/lib/server/session";
import { serverApi } from "@/lib/server/api";
import { AuthShell } from "@/components/auth-shell";
import { Sidebar } from "@/components/sidebar";
import { NotFoundContent } from "@/components/not-found-content";
import { DashboardProviders } from "./(dashboard)/providers";

/**
 * Global 404 — rendered by Next for any URL that doesn't match a route (an
 * unmatched path can't be attributed to the (dashboard) group, so Next uses
 * THIS root boundary rather than (dashboard)/not-found.tsx).
 *
 * When there's a session we render the FULL dashboard shell (sidebar + main)
 * so a 404 keeps the app chrome instead of dumping the user onto a bare page.
 * Logged out (or if the shell data can't be resolved) we fall back to the
 * branded AuthShell — the sidebar needs the session-scoped providers.
 */
export default async function NotFound() {
  const body = <NotFoundContent variant="global" />;

  const session = await getSession().catch(() => null);
  if (!session) {
    return <AuthShell maxWidth="max-w-[520px]">{body}</AuthShell>;
  }

  const deploymentInfo = await getDeploymentInfo().catch(() => null);
  if (!deploymentInfo) {
    return <AuthShell maxWidth="max-w-[520px]">{body}</AuthShell>;
  }

  const initialGithubData = await serverApi
    .get("github/home", { cache: "no-store" })
    .catch(() => null);

  return (
    <DashboardProviders
      initialGithubData={initialGithubData}
      initialUser={session.user}
      selfHosted={deploymentInfo.selfHosted}
      deployMode={deploymentInfo.deployMode}
      authMode={deploymentInfo.authMode}
      version={deploymentInfo.version}
      cloudAuthUrl={deploymentInfo.cloudAuthUrl}
      cloudApiUrl={deploymentInfo.cloudApiUrl}
      machineName={deploymentInfo.machineName}
      hostDomain={deploymentInfo.hostDomain}
    >
      <div className="flex h-dvh">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center px-6 py-10">{body}</div>
        </main>
      </div>
    </DashboardProviders>
  );
}
