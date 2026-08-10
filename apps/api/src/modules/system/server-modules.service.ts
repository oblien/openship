/**
 * Server native-module status + apply service.
 *
 * Detection: probe each server's on-box module version, compare to the VERIFIED
 * catalog (signed remote pinned ref → embedded fallback), and cache the drift in
 * `server_module_status` so the Components tab / CLI read a table. Apply: run the
 * adapter reconcile runner (verify-before-execute) on the server.
 *
 * This is the server/infra sibling of updates.service.ts (which is project-only).
 */

import { repos, type Server } from "@repo/db";
import {
  resolveEnvironment,
  resolveVerifiedCatalog,
  reconcileServerModule,
  readManifest,
  ourEdgeContainerRunning,
  type CommandExecutor,
  type ReconcileResult,
} from "@repo/adapters";
import { sshManager } from "../../lib/ssh-manager";

/** Per-module wiring: how to detect presence/version, seed a baseline, reload. */
interface ModuleDef {
  name: string;
  /** Shell that exits 0 iff the module is installed on the box. */
  presenceProbe: string;
  /** Shell to print the native binary version line. */
  versionCommand: string;
  parseVersion: (out: string) => string | undefined;
  /** Legacy on-box marker → assume this baseline so we don't replay the install. */
  seed?: { legacyMarkerPath: string; baselineVersion: string };
  /** Post-apply hook (config test + reload). Best-effort. */
  postApply?: (executor: CommandExecutor) => Promise<void>;
  /**
   * Why this module — though `presenceProbe` finds it — is NOT what serves traffic
   * on this box, or null when it is. Migrations run against the host install, so a
   * superseded module must be neither reported nor applied.
   *
   * `presenceProbe` asks "is the binary here", which stopped being the same
   * question as "is this the edge" once the edge became a container on every box.
   * A legacy box converted to the container edge keeps its host OpenResty, and
   * without this its row reads as a version for the edge while describing a config
   * nothing loads — and applying a migration would stamp that config "current"
   * and reload a binary serving nothing.
   */
  supersededBy?: (executor: CommandExecutor) => Promise<string | null>;
}

const OPENRESTY_BIN = "$(command -v openresty || echo /usr/local/openresty/bin/openresty)";

const MODULE_DEFS: Record<string, ModuleDef> = {
  openresty: {
    name: "openresty",
    presenceProbe: "command -v openresty >/dev/null 2>&1 || test -x /usr/local/openresty/bin/openresty",
    versionCommand: "openresty -v 2>&1 || /usr/local/openresty/bin/openresty -v 2>&1",
    parseVersion: (out) => out.match(/openresty\/(\S+)/)?.[1] ?? out.match(/nginx\/(\S+)/)?.[1],
    // OPENRESTY_LUA_DIR from openresty-lua.ts — where the legacy hash marker lives.
    seed: {
      legacyMarkerPath: "/usr/local/openresty/site/lualib/openship/.openship-lua-version",
      baselineVersion: "1.0.0",
    },
    postApply: async (executor) => {
      // Validate before reload; a bad config must NOT take the edge down.
      await executor.exec(`${OPENRESTY_BIN} -t 2>&1`);
      await executor.exec(`${OPENRESTY_BIN} -s reload 2>&1`);
    },
    // A running edge container OWNS 80/443 (see `ourEdgeContainerRunning`), so a
    // host binary alongside it is not the edge — and the container's config is
    // baked into its image, which is why the answer is to skip rather than to
    // `docker exec` the migration in: an edit inside the container is lost the next
    // time it is recreated. A container edge converges by taking a new image.
    //
    // Keys on RUNNING, not merely present: a Docker-less box (the case bare host
    // OpenResty still exists for) has no container to find, so it stays eligible.
    supersededBy: async (executor) =>
      (await ourEdgeContainerRunning(executor))
        ? "this box serves through the openship-edge container, whose config is baked into its image"
        : null,
  },
};

/** Modules the scanner considers on every server (only present ones get a row). */
export const KNOWN_MODULES = Object.keys(MODULE_DEFS);

export interface ServerModuleView {
  module: string;
  installed: boolean;
  installedVersion: string | null;
  migrationVersion: string | null;
  availableVersion: string | null;
  behind: boolean;
  pendingConsent: { id: string; version: string; warning?: string }[];
  autoPending: string[];
  catalogAvailable: boolean;
  note?: string;
}

async function probeVersion(executor: CommandExecutor, def: ModuleDef): Promise<string | null> {
  try {
    return def.parseVersion(await executor.exec(def.versionCommand)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect the drift for one module on one server (no mutation). Returns null when
 * the module isn't installed on the box.
 */
async function detectModule(
  executor: CommandExecutor,
  def: ModuleDef,
): Promise<ServerModuleView | null> {
  const present = await executor.exec(def.presenceProbe).then(() => true).catch(() => false);
  if (!present) return null;

  const installedVersion = await probeVersion(executor, def);
  const manifest = await readManifest(executor, def.name);
  const migrationVersion = manifest?.migrationVersion ?? null;

  const catalog = await resolveVerifiedCatalog(def.name);
  if (!catalog) {
    // No verifiable catalog (unsigned/offline) → report installed, no drift.
    return {
      module: def.name,
      installed: true,
      installedVersion,
      migrationVersion,
      availableVersion: null,
      behind: false,
      pendingConsent: [],
      autoPending: [],
      catalogAvailable: false,
      note: "no verified catalog available",
    };
  }

  // Dry-run in auto mode: `appliedSteps` = would-auto-apply, `pendingConsent` =
  // gated. Nothing is written.
  const profile = await resolveEnvironment(executor);
  const dry = await reconcileServerModule(executor, {
    module: def.name,
    profile,
    catalog,
    mode: "auto",
    dryRun: true,
    seed: def.seed,
  });

  const behind = dry.appliedSteps.length > 0 || dry.pendingConsent.length > 0;
  return {
    module: def.name,
    installed: true,
    installedVersion,
    migrationVersion: migrationVersion ?? dry.fromVersion,
    availableVersion: catalog.catalog.latest,
    behind,
    pendingConsent: dry.pendingConsent,
    autoPending: dry.appliedSteps,
    catalogAvailable: true,
  };
}

function upsertView(server: Server, view: ServerModuleView): Promise<void> {
  return repos.serverModuleStatus.upsert({
    organizationId: server.organizationId ?? null,
    serverId: server.id,
    moduleName: view.module,
    installedVersion: view.installedVersion,
    migrationVersion: view.migrationVersion,
    availableVersion: view.availableVersion,
    behind: view.behind,
    latestInProgress: false,
    currentLabel: view.migrationVersion ?? view.installedVersion,
    latestLabel: view.availableVersion,
    detail: {
      pendingConsent: view.pendingConsent,
      autoPending: view.autoPending,
      catalogAvailable: view.catalogAvailable,
      note: view.note,
    },
  });
}

/** Scan every known module on a server, caching the results. Best-effort. */
export async function scanServer(server: Server): Promise<ServerModuleView[]> {
  const views: ServerModuleView[] = [];
  await sshManager.withExecutor(server.id, async (executor) => {
    for (const name of KNOWN_MODULES) {
      const def = MODULE_DEFS[name]!;
      // Superseded → drop any row a previous scan left. A box that was bare when
      // it was last scanned and now runs the container edge would otherwise keep
      // showing a version, and an update prompt, for a config nothing loads.
      const superseded = await def.supersededBy?.(executor).catch(() => null);
      if (superseded) {
        await repos.serverModuleStatus.remove(server.id, name).catch(() => {});
        continue;
      }
      const view = await detectModule(executor, def).catch(() => null);
      if (view) {
        views.push(view);
        await upsertView(server, view).catch(() => {});
      }
    }
  });
  return views;
}

/** Apply pending migrations for one module on a server. `mode` "all" includes
 *  consent steps (an operator explicitly clicked Update). */
export async function applyServerModule(
  server: Server,
  moduleName: string,
  mode: "auto" | "all",
  onLog?: (line: string) => void,
): Promise<ReconcileResult> {
  const def = MODULE_DEFS[moduleName];
  if (!def) throw new Error(`unknown module: ${moduleName}`);

  await repos.serverModuleStatus.setInProgress(server.id, moduleName, true).catch(() => {});
  try {
    return await sshManager.withExecutor(server.id, async (executor) => {
      // Checked here too, not just in the scan: a row cached before the box moved
      // to the container edge still renders an Update button, and the CLI and API
      // can call this directly. Applying would rewrite a config nothing loads and
      // stamp it current.
      const superseded = await def.supersededBy?.(executor).catch(() => null);
      if (superseded) {
        throw new Error(`${moduleName} migrations do not apply here: ${superseded}`);
      }
      const catalog = await resolveVerifiedCatalog(moduleName);
      if (!catalog) {
        throw new Error(`no verified catalog available for ${moduleName} (unsigned/offline)`);
      }
      const profile = await resolveEnvironment(executor);
      const result = await reconcileServerModule(executor, {
        module: moduleName,
        profile,
        catalog,
        mode,
        seed: def.seed,
        onLog,
        postApply: def.postApply,
      });
      // Refresh the cached row from the post-apply reality.
      const view = await detectModule(executor, def).catch(() => null);
      if (view) await upsertView(server, view).catch(() => {});
      return result;
    });
  } finally {
    await repos.serverModuleStatus.setInProgress(server.id, moduleName, false).catch(() => {});
  }
}

/** Instance-wide detection sweep for the `modules:scan` job (all servers, all
 *  orgs). Detection only — never applies. Best-effort per server. */
export async function scanInstanceModules(): Promise<{ servers: number; behind: number }> {
  const servers = await repos.server.list();
  let behind = 0;
  for (const server of servers) {
    try {
      const views = await scanServer(server);
      behind += views.filter((v) => v.behind).length;
    } catch {
      // Unreachable server / probe failure → skip, try next.
    }
  }
  return { servers: servers.length, behind };
}
