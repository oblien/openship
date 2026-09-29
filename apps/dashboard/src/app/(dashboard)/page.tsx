import { Suspense } from "react";
import { MailConsole } from "./emails/_components/mail-console";
import { serverApi } from "@/lib/server/api";
import { getDeploymentInfoOrNull } from "@/lib/server/session";
import { resolveRequestProductView } from "@/lib/server/product-view";
import { CloudHomePlanCard } from "@/components/billing/CloudHomePlanCard";
import { getBillingPageState } from "./billing/_components/billing-state";
import DashboardHomeClient from "./DashboardHomeClient";

async function HomePlanCard() {
  const result = await getBillingPageState();
  // Show an offer only after billing confirms this workspace's eligibility.
  if (result.kind !== "ok") return null;
  return <CloudHomePlanCard state={result.state} />;
}

/**
 * The dashboard home, per product view.
 *
 * In Openship Mail this IS the mail console — the server list, or the scoped
 * server, whichever `resolveMailView()` picks. Rendered, not redirected: the URL
 * stays `/`, which is where login lands, so a mail operator never sees the URL
 * bounce to /emails?serverId=… on every visit and never lands on a dashboard of
 * projects they do not keep.
 *
 * Why the branch is here and not a rewrite in next.config.mjs or src/proxy.ts:
 * both of those see only the `openship-product-view` cookie, and mail mode is
 * just as often the instance-wide default (`instance_settings.product_mode`, read
 * over the API) with no cookie set at all — a cookie-gated rewrite would send
 * every fresh browser on a mail box to the platform home. This resolves through
 * the same `resolveRequestProductView()` the layout uses, so the rail and the
 * page cannot disagree about which product is on screen.
 *
 * It also means `projects/home` is never fetched in mail view. The platform's
 * home payload (projects, deployments, activity) is work no one asked for on a
 * box whose rail has no projects page.
 */
export default async function DashboardHome() {
  const deploymentInfo = await getDeploymentInfoOrNull();
  if ((await resolveRequestProductView(deploymentInfo)) === "mail") {
    return <MailConsole />;
  }

  let initialData = null;
  try {
    initialData = await serverApi.get("projects/home", {
      cache: "no-store",
    });
  } catch (error) {
    console.error("Failed to fetch initial dashboard data", error);
  }

  const hostedCloud = deploymentInfo?.selfHosted === false && deploymentInfo.deployMode !== "desktop";
  return (
    <DashboardHomeClient
      initialData={initialData}
      initialHour={new Date().getHours()}
      planCard={hostedCloud ? (
        <Suspense fallback={null}>
          <HomePlanCard />
        </Suspense>
      ) : null}
    />
  );
}
