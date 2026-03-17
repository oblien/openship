import { redirect } from "next/navigation";
import { getSession, getDeploymentInfo } from "@/lib/server/session";
import { AuthProviders } from "./providers";

/**
 * Auth layout — minimal shell, no sidebar.
 * If the user already has a valid session, redirect to dashboard.
 * Passes deployment info to auth pages via context.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session) redirect("/");

  const deploymentInfo = await getDeploymentInfo();

  return (
    <AuthProviders authMode={deploymentInfo.authMode} cloudAuthUrl={deploymentInfo.cloudAuthUrl} selfHosted={deploymentInfo.selfHosted}>
      <div className="th-page">{children}</div>
    </AuthProviders>
  );
}
