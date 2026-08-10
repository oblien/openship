import { pgTable, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { servers } from "./servers";
import { organization } from "./organization";

/**
 * Cached drift state for an Openship-managed CONTAINER on a server — one row per
 * (server, component). The container sibling of `server_module_status`: that
 * table tracks host-native modules (OpenResty binary + Lua migrations); this
 * tracks the versioned images the control plane ships — the edge (every box) and
 * the mail engine (mail boxes only).
 *
 * "Behind" is a plain tag comparison, not a catalog dry-run: infra images are
 * pinned to the control plane's APP_VERSION (`pinnedEdgeImage`/`pinnedMailImage`),
 * so `runningLabel !== pinnedLabel` IS the drift. No registry digest probe is
 * needed. The `infra:scan` job refreshes this so the server's Components tab can
 * render "vX → vY, Update" without an SSH round-trip, and the version-change boot
 * hook reads it to decide what to auto-reconcile.
 *
 * `organizationId` is nullable because `servers.organizationId` is nullable
 * (org-less servers exist); the org+behind index tolerates NULL.
 */
export interface ServerContainerDetail {
  /** Last apply error, surfaced in the Components tab until the next clean scan. */
  lastError?: string;
  /** The component's container is expected but not currently running. */
  down?: boolean;
  /**
   * Down AND the container itself is gone (not merely stopped). A stopped
   * container can be started back up in place; a missing one has to be recreated
   * from the secrets/config only its setup path holds, so the UI offers a fix for
   * the former and points at setup for the latter.
   */
  containerMissing?: boolean;
  /**
   * Which shape of the component the box runs — `mail` only. `host` marks a LEGACY
   * pre-containerization install (systemd Postfix/Dovecot): it serves mail with no
   * image at all, so version and drift are meaningless there and the UI labels it
   * instead of rendering an empty version. Absent = the containerized engine.
   */
  flavor?: "container" | "host";
}

export const serverContainerStatus = pgTable(
  "server_container_status",
  {
    id: text("id").primaryKey(), // "scs_..."
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    /** Which managed container: "edge" | "mail". */
    component: text("component").notNull().$type<"edge" | "mail">(),
    /** Image ref the container is CURRENTLY running (null when down/absent). */
    runningLabel: text("running_label"),
    /** Image ref the control plane pins for this component (the target). */
    pinnedLabel: text("pinned_label"),
    /**
     * The human-readable VERSION (image tag) the container is running vs the one
     * it should run — parsed from the refs above so the Components tab can show
     * "edge v0.4.0 → v0.5.0" without the caller re-parsing the ref. Null when a
     * ref carries no tag (digest-pinned / down).
     */
    runningVersion: text("running_version"),
    pinnedVersion: text("pinned_version"),
    /** True when runningLabel !== pinnedLabel (an update is available). */
    behind: boolean("behind").notNull().default(false),
    /** An image swap is already running — suppress duplicate nudges. */
    latestInProgress: boolean("latest_in_progress").notNull().default(false),
    /** { lastError, down, containerMissing, flavor }. */
    detail: jsonb("detail").$type<ServerContainerDetail>(),
    checkedAt: timestamp("checked_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_server_container_status").on(t.serverId, t.component),
    index("idx_server_container_status_org_behind").on(t.organizationId, t.behind),
  ],
);
