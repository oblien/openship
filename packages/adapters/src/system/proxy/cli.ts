/**
 * Lean entrypoint for the host-side edge preflight in `openship up` (the CLI).
 *
 * The CLI bundles workspace packages inline (see apps/cli/tsup.config.ts
 * `noExternal: [/^@repo\//]`), so it must NOT import the `@repo/adapters` barrel —
 * that drags in ssh2 / dockerode / @aws-sdk / oblien (executors, docker runtime,
 * backups, cloud client). This subpath re-exports ONLY the shell-based proxy
 * detect / enumerate / free primitives + `LocalExecutor`, whose transitive graph
 * is free of those heavy deps.
 *
 * Registration of migrated sites into the CONTAINER edge is NOT done here — the
 * containerized api owns that (POST /api/system/edge/import-sites), because it
 * needs the running edge container + the shared routing volumes + the docker
 * socket. The CLI only detects, enumerates, and (on consent) stops the foreign
 * proxy on the host before `docker compose up`.
 */
export {
  probeEdge,
  detectEdge,
  describeEdgeOwner,
  foreignProxyOnEdge,
  importSites,
  freeEdgeTargets,
  stopTargetsForStatus,
} from "./index";
export {
  ourEdgeContainerRunning,
  // The edge container's name + the one parse of "why isn't it running" — the CLI
  // needs both so it stops hardcoding the name and re-implementing the parse.
  EDGE_CONTAINER_NAME,
  edgeFailureReason,
  edgeIsBroken,
  edgeCrashReason,
  sanitizeEdgeVhosts,
} from "./detect";
// Recover the sites of a proxy we already STOPPED: probeEdge can't see it (it
// holds no ports), but its vhosts are still on disk and the parsers are read-only.
export { detectInstalledProxy, scanImportableSites } from "./import";
// Static-root remediation: detect adopted static docroots the containerized edge
// can't see, and copy them into its bind mount host-side before cutover. Same
// module already in the lean graph, so no new deps.
export { unreachableStaticRoots, copyStaticRootIntoEdge } from "./import";
export type { UnreachableStaticRoot } from "./import";
// The read api — the CLI harvests the source proxy's certs host-side (a
// containerized edge can't read the host FS) and needs the SAME reader the api
// uses, or caddy/traefik boxes carry nothing. Shell + node:crypto only; no ssh2 /
// dockerode / aws in its graph.
export { edgeProxy, edgeProxyFor, collectProxyCerts } from "./api";
export type { EdgeProxyApi, AdoptedCert, CertCandidate } from "./api";
// The rollback journal — same file + same restore logic the api uses, so a
// takeover the CLI starts can be finished OR rolled back by either side. Lives in
// takeover-journal.ts precisely so this lean subpath doesn't pull in the OpenResty
// installer / NginxProvider that the full takeover needs.
export {
  beginEdgeTakeover,
  completeEdgeTakeover,
  rollbackEdgeTakeover,
  recoverInterruptedTakeover,
} from "./takeover-journal";
export { LocalExecutor } from "../local-executor";
export type {
  ProxyKind,
  EdgeStatus,
  EdgeStopTarget,
  ImportedSite,
  ProxyScanResult,
} from "../types";
export type { CommandExecutor } from "../../types";
