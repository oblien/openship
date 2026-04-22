import { env } from "../config/env";
import { getOblienClient } from "./openship-cloud";
import type { Oblien } from "@repo/adapters";

/**
 * Resolve an admin-scoped Oblien client for analytics + edge proxy queries.
 *
 * SaaS (CLOUD_MODE): returns the master client (admin scope).
 * Local/desktop:     returns null — caller must use cloudAnalyticsProxy().
 */
export function getAdminOblienClient(): Oblien | null {
  if (!env.CLOUD_MODE) return null;
  return getOblienClient();
}