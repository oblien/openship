import { notFound } from "next/navigation";
import { MonitoringPreview } from "./MonitoringPreview";

/**
 * Layout preview for the project Monitoring tab, rendered from fixtures.
 *
 * Why this route exists: the tab needs a control plane, a deployed compose project and
 * days of real traffic before it renders anything — so it shipped twice on a typecheck
 * alone, and its layout problems only surfaced when someone finally opened it. This
 * makes the layout reviewable in a browser with no backend at all, including the states
 * that are otherwise hard to produce on demand (a crash-looping service, a sampler gap,
 * an edge with no GeoIP, a static site with nothing to measure).
 *
 * DEV ONLY. 404s in a production build so it can't ship as a reachable page.
 */
export default function DevMonitoringPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MonitoringPreview />;
}
