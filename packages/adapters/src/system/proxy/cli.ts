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
export { ourEdgeContainerRunning } from "./detect";
// Recover the sites of a proxy we already STOPPED: probeEdge can't see it (it
// holds no ports), but its vhosts are still on disk and the parsers are read-only.
export { detectInstalledProxy, scanImportableSites } from "./import";
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
