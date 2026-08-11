import { notFound } from "next/navigation";
import { IssuesPreview } from "./IssuesPreview";

/**
 * Layout preview for the global issue feed.
 *
 * DEV ONLY. 404s in a production build so it can't ship as a reachable page.
 * Same idea as `/dev/attention` and `/dev/monitoring`.
 */
export default function DevIssuesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <IssuesPreview />;
}
