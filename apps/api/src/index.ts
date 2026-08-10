import { serve } from "@hono/node-server";
import {
  setBackupCredentialSecret,
  setDefaultEdgeImage,
  setDefaultMailImage,
  setManagedImagesFromSource,
} from "@repo/adapters";
import { isDevWatchReload } from "@repo/db";
import { app } from "./app";
import { cloudRuntimeTarget, cloudRuntimeTargetId, env, runtimeTargetId } from "./config/env";
import { getAuthMode } from "./lib/auth-mode";
import { edgeBuildSpec, pinnedEdgeImage } from "./lib/edge-image";
import { mailBuildSpec, pinnedMailImage } from "./lib/mail-image";
import { getJobRunner } from "./lib/job-runner";
import { enforceRouteScanAtBoot } from "./lib/route-scanner";
import { attachTunnelingLifecycle, type TunnelingLifecycle } from "./modules/tunneling";

const port = env.PORT;
// Bind host. Unset → @hono/node-server listens on 0.0.0.0 (unchanged default).
// `openship up --public-url` sets 127.0.0.1 so ONLY the same-box dashboard proxy
// reaches the API — the API itself is never publicly exposed.
const hostname = process.env.OPENSHIP_API_HOST?.trim() || undefined;

// Hand the adapters' backup-credential decrypt the SAME resolved secret the API
// encrypts with (env applies the BETTER_AUTH_SECRET default; process.env may
// not). Single source, no process.env mutation — see backup/common/credentials.
setBackupCredentialSecret(env.BETTER_AUTH_SECRET);

// Same pattern, same reason: adapters can't derive the pinned edge image (it comes
// from APP_VERSION, i.e. apps/api/package.json), so declare it once here. Without
// this, any edge install that forgot to pass the pin fell back to `:latest` and
// could run edge Lua from a different build than the API driving it. In a dev
// checkout `pinnedEdgeImage()` carries a content-derived `…-dev.<hash>` suffix, so a
// source edit moves the tag and the drift scan flips `behind`; `deliverManagedImage`
// builds that tag from our source on the control plane and ships it to the box.
setDefaultEdgeImage(pinnedEdgeImage());

// Same pattern for the mail engine: adapters can't derive the APP_VERSION-pinned
// ref, so declare it once here so a mail install that passes no image still runs
// the engine matching this build (dev-suffixed the same way).
setDefaultMailImage(pinnedMailImage());

// Tell the adapters, PER COMPONENT, whether its managed image is FROM SOURCE (a dev
// checkout with a build spec) vs a pulled published tag (prod). Same signal that
// dev-suffixes the tags above. When from-source, a managed image missing from a box
// means the control-plane build/ship didn't complete — the tag is unpublished, so
// create/swap surface that plainly instead of a doomed `docker pull` that blames the
// registry. Per component because a box may build one from source while pulling the
// other's published tag. No build spec (prod / compiled) ⇒ false ⇒ pulls as before.
setManagedImagesFromSource("edge", Boolean(edgeBuildSpec()));
setManagedImagesFromSource("mail", Boolean(mailBuildSpec()));

// Refuse to start if any registered route is mis-tagged or any
// mutation route was mounted on a raw Hono instance (bypassing
// secureRouter). The scanner exits the process on critical errors.
enforceRouteScanAtBoot(app);

const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, (info) => {
  console.log(`Openship API running on http://${hostname ?? "localhost"}:${info.port}`);
  // Visible echo of the resolved runtime + cloud target. The full
  // `[env]` line at module load already prints OPENSHIP_TARGET + the
  // resolved URLs; this second line confirms the SAME resolution at
  // serve-time so anyone seeing a wrong URL can immediately tell
  // whether the process picked the right row.
  console.log(
    `  runtime=${runtimeTargetId}  cloud=${cloudRuntimeTargetId} (${cloudRuntimeTarget.dashboard})`,
  );
});

// Boot-time WARNING when zero-auth is enabled on a non-desktop
// deployment. The loopback-only guard in authMiddleware is the actual
// safety net (zero-auth requests are refused unless they originate
// from 127.0.0.1/::1) — this banner exists so an operator who flipped
// the switch and then bound the API to a public interface sees a
// screaming log line every restart.
void (async () => {
  if (env.DEPLOY_MODE === "desktop") return;
  if ((await getAuthMode()) !== "none") return;
  console.error("");
  console.error("!!! ZERO-AUTH ENABLED — anyone reaching this instance can act as admin.");
  console.error("!!! Loopback-only guard is in authMiddleware.");
  console.error("");
})();

// Attach the tunnel agent lifecycle if this instance has been migrated
// via Path C (teamMode === "tunneled"). Local-API-only by design —
// CLOUD_MODE returns a no-op handle without touching state. Lives after
// `serve` so the local HTTP listener is bound before we publish the
// public URL via the broker.
let tunneling: TunnelingLifecycle = { stop: () => {}, attached: false };
void attachTunnelingLifecycle().then((handle) => {
  tunneling = handle;
});

// WebSocket support is needed for:
//   - interactive server terminal (self-hosted only)
//   - interactive service terminal (cloud + self-hosted — adapter
//     selects Docker exec or Oblien workspace based on the service's
//     deployment platform)
// Either mode uses WS, so we always inject. Cloud-mode pays the
// @hono/node-ws cost regardless.
{
  const { injectWebSocket } = await import("./lib/ws");
  injectWebSocket(server);
}

// ─── Graceful shutdown ──────────────────────────────────────────────
//
// First time this codebase has a signal handler. Order of operations
// when SIGTERM / SIGINT arrives (typical kubectl rollout / docker stop
// / Ctrl-C scenarios):
//
//   1. Close BullMQ workers so they stop picking new jobs but FINISH
//      whatever they're processing right now. Backup runs in flight
//      get to complete — partial uploads to S3 would otherwise leave
//      orphaned multipart uploads.
//   2. Close BullMQ queues + the shared Redis connection.
//   3. Close the HTTP server so it stops accepting new connections
//      but lets in-flight ones drain.
//
// 30s deadline overall — matches Docker's default SIGKILL timeout.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);

  const deadline = setTimeout(() => {
    console.warn("Shutdown deadline exceeded — exiting forcibly");
    process.exit(1);
  }, 30_000);
  deadline.unref();

  // Close the tunnel agent BEFORE the HTTP server so in-flight
  // dashboard requests routed through the broker stop arriving while
  // the local listener is still up to drain whatever's mid-flight.
  // No-op on CLOUD_MODE (the attached handle is the frozen no-op).
  try {
    tunneling.stop();
  } catch (err) {
    console.warn("[shutdown] tunnel close failed:", err);
  }

  // A dev `--watch` reload is a RACE, not a graceful stop: the successor process
  // is already up and will SIGKILL us after DEV_LOCK_TAKEOVER_GRACE_MS to claim
  // the PGlite lock. Every second spent draining tunnels and jobs here is a
  // second stolen from closeDb(), which is what actually frees that lock and
  // checkpoints the database. Losing that race hard-kills PGlite mid-close, so
  // the next boot pays WAL replay/recovery — the reason hot reloads felt slow and
  // sometimes needed a second restart. So under a reload we drain almost nothing
  // and race straight to closeDb(); a real shutdown (prod/desktop/Ctrl-C on a
  // non-watch run) keeps the full graceful path.
  const fastReload = isDevWatchReload();
  if (fastReload) {
    console.log("[shutdown] dev hot-reload — skipping drains to release the database lock");
  }

  // Close any live SSH port-forward tunnels (desktop-only feature; the
  // manager is RAM-only, so this Map is empty on SaaS/VPS and the import
  // is cheap). Dynamic import keeps it off the cloud startup path.
  // Skipped on a reload: the successor re-opens them from `listAutoStart()` at
  // boot anyway, and the OS reclaims the sockets when we exit.
  if (!fastReload) {
    try {
      const { stopAllTunnels } = await import("./lib/ssh-tunnel-manager");
      await stopAllTunnels();
    } catch (err) {
      console.warn("[shutdown] port-forward close failed:", err);
    }

    // Health-watch Docker event streams. Each holds a `retain()` on a pooled SSH
    // connection, so these must be released before sshManager.destroy() below —
    // and before it, not after, so the pool isn't tearing down connections a
    // reconnect is still trying to use. Skipped on a reload for the same reason as
    // the tunnels: the successor's first poll tick re-subscribes.
    try {
      const { stopAllContainerEventWatchers } = await import(
        "./modules/monitoring/container-events"
      );
      await stopAllContainerEventWatchers();
    } catch (err) {
      console.warn("[shutdown] container event watcher close failed:", err);
    }
  }

  try {
    const runner = await getJobRunner();
    // Budget must leave room for closeDb() inside the takeover grace; a dev
    // reload abandons in-flight jobs rather than the database.
    await runner.shutdown(fastReload ? 500 : 20_000);
  } catch (err) {
    console.warn("[shutdown] job runner close failed:", err);
  }

  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) console.warn("[shutdown] server close failed:", err);
      resolve();
    });
  });

  // Close the DB after the HTTP server and jobs (both use it) have drained.
  // For embedded PGlite this frees the single-instance lock so the next start
  // opens the data dir cleanly instead of racing a not-yet-released lock.
  try {
    const { closeDb } = await import("@repo/db");
    await closeDb();
  } catch (err) {
    console.warn("[shutdown] db close failed:", err);
  }

  // Last: dispose the pooled SSH connections now that jobs and in-flight HTTP
  // (both of which use them) have drained. This ends() each ssh2 client and
  // sends `ssh -O exit` to each system-ssh ControlMaster — the latter is a
  // daemonized process that would otherwise linger on the remote host past
  // this process's exit. Bounded internally, so it can't outrun the deadline.
  try {
    const { sshManager } = await import("./lib/ssh-manager");
    await sshManager.destroy();
  } catch (err) {
    console.warn("[shutdown] ssh pool close failed:", err);
  }

  clearTimeout(deadline);
  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
