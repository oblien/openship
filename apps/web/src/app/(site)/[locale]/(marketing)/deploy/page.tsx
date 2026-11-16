import type { Metadata, ResolvingMetadata } from "next";
import { parseDeploySource, type DeploySource } from "@repo/core";
import { getMarketplaceApps } from "@/lib/app-catalog";
import { DeployLauncher } from "@/components/deploy/deploy-launcher";
import { localizedMetadata } from "@/i18n/metadata";
import { inheritSocialImages } from "@/lib/social-metadata";

const metadata: Metadata = {
  title: "Deploy with OpenShip",
  description:
    "Deploy an app on OpenShip Cloud or your own server. Choose your destination and review the configuration before deploying.",
  alternates: { canonical: "/deploy" },
  robots: { index: false, follow: true },
  openGraph: {
    title: "Deploy with OpenShip",
    description: "Deploy on OpenShip Cloud or your own server.",
    url: "/deploy",
  },
  twitter: {
    card: "summary_large_image",
    title: "Deploy with OpenShip",
    description: "Deploy on OpenShip Cloud or your own server.",
  },
};

export async function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default async function DeployPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  let source: DeploySource | null = null;
  let error: string | undefined;
  if (query.app !== undefined || query.repo !== undefined || query.branch !== undefined) {
    try {
      source = parseDeploySource(query);
    } catch (cause) {
      // diagnostics-ignore: malformed public link parameters are expected validation failures.
      error = cause instanceof Error ? cause.message : "Invalid deployment link.";
    }
  }
  const appId = source?.kind === "app" ? source.appId : undefined;
  const app = appId ? (await getMarketplaceApps()).find((app) => app.id === appId) : undefined;
  if (source?.kind === "app" && (!app || !app.available)) {
    source = null;
    error =
      "This app is not available to deploy. Choose an available app from the catalog or use a repository.";
  }
  return (
    <DeployLauncher
      source={source}
      app={
        app
          ? {
              id: app.id,
              name: app.name,
              logo: app.logo,
              supportsCloud: app.supportsCloud,
              kind: app.kind,
            }
          : undefined
      }
      error={error}
    />
  );
}
