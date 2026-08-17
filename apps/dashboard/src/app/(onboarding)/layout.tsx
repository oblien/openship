import { getDeploymentInfoOrNull } from "@/lib/server/session";
import { ApiUnavailable } from "@/components/api-unavailable";
import { OnboardingProviders } from "./providers";

/**
 * Onboarding layout - standalone, no sidebar.
 * Public route (no session required).
 * Used by desktop app (Electron), CLI (opens browser), and direct first-run access.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const deploymentInfo = await getDeploymentInfoOrNull();
  if (!deploymentInfo) return <ApiUnavailable />;

  return (
    <OnboardingProviders
      authMode={deploymentInfo.authMode}
      selfHosted={deploymentInfo.selfHosted}
      deployMode={deploymentInfo.deployMode}
      cloudAuthUrl={deploymentInfo.cloudAuthUrl}
      features={deploymentInfo.features}
    >
      <div className="th-page">{children}</div>
    </OnboardingProviders>
  );
}
