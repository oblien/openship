"use client";

import { GitHubProvider } from "@/context/GitHubContext";
import { CloudProvider } from "@/context/CloudContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { MailScopeProvider } from "@/context/MailScopeContext";
import { AuthProvider, type AuthUser } from "@/context/AuthContext";
import { ModalProvider } from "@/context/ModalContext";
import type { ProductView } from "@/lib/product-view";

interface DashboardProvidersProps {
  children: React.ReactNode;
  selfHosted: boolean;
  deployMode: string;
  isServerHost?: boolean;
  hostControlEnabled?: boolean;
  authMode: "cloud" | "local" | "none";
  version?: string;
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
  isServerHost,
  hostControlEnabled,
  authMode,
  version,
  productMode,
  productView,
  cloudAuthUrl,
  cloudApiUrl,
  machineName,
  hostDomain,
}: DashboardProvidersProps) {
  // Modal content renders where its provider lives, even when opened by a
  // descendant. Keep dashboard dialogs inside their platform/auth/mail context;
  // the root layout's provider serves public screens outside this shell.
  const content = <ModalProvider>{children}</ModalProvider>;
  return (
    <AuthProvider initialUser={initialUser}>
      <PlatformProvider
        selfHosted={selfHosted}
        deployMode={deployMode}
        isServerHost={isServerHost}
        hostControlEnabled={hostControlEnabled}
        authMode={authMode}
        version={version}
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
            {productView === "mail" ? <MailScopeProvider>{content}</MailScopeProvider> : content}
          </CloudProvider>
        </GitHubProvider>
      </PlatformProvider>
    </AuthProvider>
  );
}
