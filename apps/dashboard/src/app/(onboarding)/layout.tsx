import { getDeploymentInfo } from "@/lib/server/session";
import { OnboardingProviders } from "./providers";

/**
 * Onboarding layout — standalone, no sidebar.
 * Public route (no session required).
 * Used by desktop app (Electron), CLI (opens browser), and direct first-run access.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const deploymentInfo = await getDeploymentInfo();

  return (
    <OnboardingProviders
      authMode={deploymentInfo.authMode}
      selfHosted={deploymentInfo.selfHosted}
      cloudAuthUrl={deploymentInfo.cloudAuthUrl}
    >
      <div className="th-page">{children}</div>
    </OnboardingProviders>
  );
}
