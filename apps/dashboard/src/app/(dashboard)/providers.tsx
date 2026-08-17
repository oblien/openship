"use client";

import type { Edition, EditionFeatures } from "@repo/core";
import { GitHubProvider } from "@/context/GitHubContext";
import { CloudProvider } from "@/context/CloudContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { MailScopeProvider } from "@/context/MailScopeContext";
import { AuthProvider, type AuthUser } from "@/context/AuthContext";
import type { ProductView } from "@/lib/product-view";

interface DashboardProvidersProps {
  children: React.ReactNode;
  selfHosted: boolean;
  deployMode: string;
  edition?: Edition;
  features?: EditionFeatures;
  isServerHost?: boolean;
  hostControlEnabled?: boolean;
  authMode: "cloud" | "local" | "none";
  /** What the instance declares it is. */
  productMode?: ProductView;
  /** What THIS user sees — instance mode plus their cookie override. Resolved in
   *  the server layout so the rail is correct on first paint. */
  productView?: ProductView;
  cloudAuthUrl: string;
  cloudApiUrl: string;
  machineName?: string;
  hostDomain?: string;
  initialUser?: AuthUser | null;
  initialGithubData?: any;
}

export function DashboardProviders({
  children,
  initialGithubData,
  initialUser,
  selfHosted,
  deployMode,
  edition,
  features,
  isServerHost,
  hostControlEnabled,
  authMode,
  productMode,
  productView,
  cloudAuthUrl,
  cloudApiUrl,
  machineName,
  hostDomain,
}: DashboardProvidersProps) {
  return (
    <AuthProvider initialUser={initialUser}>
      <PlatformProvider
        selfHosted={selfHosted}
        deployMode={deployMode}
        edition={edition}
        features={features}
        isServerHost={isServerHost}
        hostControlEnabled={hostControlEnabled}
        authMode={authMode}
        productMode={productMode}
        productView={productView}
        cloudAuthUrl={cloudAuthUrl}
        cloudApiUrl={cloudApiUrl}
        machineName={machineName}
        hostDomain={hostDomain}
      >
        <GitHubProvider initialData={initialGithubData}>
          <CloudProvider>
            {/* Mounted only in mail view: it fetches the mail-server registry on
                every page, and that call SSH-scans when the registry is empty
                (backfill from pre-table installs) — not something a platform-mode
                dashboard should pay for. Consumers get an unloaded shape when
                it's absent, so nothing breaks. */}
            {productView === "mail" ? (
              <MailScopeProvider>{children}</MailScopeProvider>
            ) : (
              children
            )}
          </CloudProvider>
        </GitHubProvider>
      </PlatformProvider>
    </AuthProvider>
  );
}
