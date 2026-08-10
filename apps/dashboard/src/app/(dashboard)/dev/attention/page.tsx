import { notFound } from "next/navigation";
import { AttentionPreview } from "./AttentionPreview";

/**
 * Layout preview for the home "Needs attention" / "Updates available" cards.
 *
 * Why this route exists: the cards replace the home tip card only when something is
 * actually down or behind, so reviewing them means stopping a container on a live
 * server — and until someone did, they shipped visually flatter than the rotating
 * product tip they outrank. Same idea as `/dev/monitoring`.
 *
 * DEV ONLY. 404s in a production build so it can't ship as a reachable page.
 */
export default function DevAttentionPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AttentionPreview />;
}
