/**
 * The optimistic domain row a route save writes into local state so the card
 * updates before the refetch lands.
 *
 * Pulled out of DomainSettings because of the bug it carried: the row's `id` used
 * to fall back to the endpoint's draft id and then to the bare hostname, and every
 * downstream guard reads that id (`domainId`) as PROOF the server row exists —
 * `canVerify = needsVerify && !!domainId` gates the Verify button, the DNS-records
 * panel and the auto-DNS plan. So a hostname with no row yet rendered a live
 * Verify that POSTed `/domains/<hostname>/verify` and 404'd (permission.assert
 * resolves the resource's org via `repos.domain.findById` and throws NotFoundError
 * when it can't — deliberately 404, not 403), and the records fetch failed too.
 *
 * The rule this file exists to pin: **only an id that came from a row we actually
 * loaded may travel onto the optimistic row.** Everything else about the row is a
 * display placeholder and is allowed to be optimistic; the id is not, because it
 * is the one field that promises the server can act on it.
 */

/** The subset of a loaded domain row this builder reads. */
export interface LoadedDomainRow {
  id?: unknown;
  hostname?: unknown;
  verified?: boolean;
  status?: string;
  sslStatus?: string;
  [key: string]: unknown;
}

/** The subset of a saved endpoint payload this builder reads. */
export interface SavedEndpoint {
  domainType?: string;
  domain?: string;
  customDomain?: string;
  port?: number | null;
  targetPath?: string | null;
}

/**
 * The row this project already has for `hostname`, matched by the draft's id
 * first (an endpoint loaded from `/info` carries its row's id) then by hostname.
 * A match here is what makes an id trustworthy — it came out of the loaded list.
 */
export function findLoadedDomainRow(
  rows: readonly LoadedDomainRow[] | undefined,
  hostname: string,
  draftId?: unknown,
): LoadedDomainRow | undefined {
  if (!Array.isArray(rows)) return undefined;
  return rows.find(
    (row) =>
      (typeof row?.id === "string" && typeof draftId === "string" && row.id === draftId) ||
      row?.hostname === hostname,
  );
}

export function buildOptimisticDomainRow(input: {
  endpoint: SavedEndpoint;
  hostname: string;
  /** The loaded row for this hostname, or undefined when there is none yet. */
  existing: LoadedDomainRow | undefined;
  /** Endpoint order is the source of truth for primary — index 0 is primary. */
  index: number;
}): Record<string, unknown> {
  const { endpoint, hostname, existing, index } = input;
  // Custom domains are pending until DNS-verified (matches the backend);
  // free/managed domains are host-verified immediately. Don't optimistically
  // flash a new custom domain as "Verified".
  const isCustom = endpoint.domainType === "custom";
  return {
    ...existing,
    // NOT `|| draftId || hostname`. See the file header: an invented id renders a
    // Verify button that 404s. Undefined is the honest answer — the card shows
    // Pending with no action until the refetch lands the real row.
    id: typeof existing?.id === "string" ? existing.id : undefined,
    hostname,
    domain: hostname,
    primary: index === 0,
    isPrimary: index === 0,
    verified: existing?.verified ?? !isCustom,
    status: existing?.status ?? (isCustom ? "pending" : "active"),
    sslStatus: existing?.sslStatus ?? (endpoint.domainType === "free" ? "active" : "none"),
    targetPort: endpoint.port ?? null,
    targetPath: endpoint.targetPath ?? null,
    domainType: endpoint.domainType,
  };
}
