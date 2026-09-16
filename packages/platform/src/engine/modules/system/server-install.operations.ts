/** Server setup sessions and monitoring, independent of HTTP stream lifetimes. */
import type { ServerDependencies } from "../../../servers";
import { OperationError, type DeploymentEvent } from "@repo/contracts";
import {
  COMPONENT_INSTALLERS, checkComponents, ensureEdge, recoverInterruptedTakeover, SERVER_STATS_COMMAND,
  getSystemComponentDefinition, resolveSystemComponentInstallPlan, type PromptUserFn,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { subscriptionEvents } from "../../../event-stream";
import { createTaskGroup } from "../../../state/task-group";
import { trackBackgroundWork } from "../../lib/background-work";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { sshManager } from "../../lib/ssh-manager";
import { withPinnedEdgeImage } from "../../lib/edge-image";
import { resolveAcmeProviderOptions } from "../../lib/acme-config";
import { assertSelfHosted, assertServerExecution, requireSelfHostedServer } from "./server-access";
import { ALLOWED_COMPONENTS, deliverEdgeBeforeInstall, installPrerequisites, dependencyFailureMessage, failSystem } from "./server-check.operations";
import { refreshServerContainer } from "./server-containers.service";
import {
  createSetupSession, getSetupSession, getActiveSetupSession, updateComponentProgress, appendSetupLog,
  finishSetupSession, subscribeSetupSession, promptSetupUser, respondToSetupPrompt, rejectPendingSetupPrompt, setupPromptState,
} from "./setup-session";

const installations = createTaskGroup();
export const drainServerInstallations = installations.drain;

export const serverInstallationDependencies: NonNullable<ServerDependencies["installations"]> = {
  async lookup(input) {
    assertSelfHosted();
    const session = input.sessionId ? getSetupSession(input.sessionId) : getActiveSetupSession();
    if (!session) return { active: false };
    return {
      active: true, sessionId: session.id, serverId: session.serverId, status: session.status,
      components: session.components, startedAt: session.startedAt, finishedAt: session.finishedAt,
    };
  },
  async respond(ctx, sessionId, action) {
    if (!respondToSetupPrompt(sessionId, action)) throw new OperationError("no_pending_prompt", 409, "NO_PENDING_PROMPT");
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:admin", resourceType: "server", resourceId: getSetupSession(sessionId)!.serverId });
    return { ok: true };
  },
  events(_ctx, sessionId, signal) {
    return subscriptionEvents(writer => subscribeSetupSession(sessionId, writer), signal);
  },
  async start(ctx, serverId, body, signal) {
    await assertServerExecution(await requireSelfHostedServer(ctx, serverId));
    signal?.throwIfAborted();
    const validNames = body.components.filter(name => ALLOWED_COMPONENTS.has(name));
    if (validNames.length === 0) return failSystem({ error: "Invalid component names" }, 400);
    const config = withPinnedEdgeImage(body.config ?? {});
    const installNames = resolveSystemComponentInstallPlan(validNames);
    const explicitlyRequested = new Set(validNames);
    const existing = getActiveSetupSession();
    if (existing) {
      let visible = false;
      try {
        await authorization.authorize(ctx, { resourceType: "server", resourceId: existing.serverId, action: "admin" });
        visible = true;
      } catch { /* The busy response must not reveal another tenant's session id. */ }
      return failSystem({ error: "install_in_progress", ...(visible && { sessionId: existing.id }) }, 409);
    }
    const componentMeta = installNames.map(name => ({ name, label: getSystemComponentDefinition(name).label }));
    const session = createSetupSession(componentMeta, serverId);
    let disconnected = false;
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const disconnect = () => {
      disconnected = true;
      if (done || grace) return;
      grace = setTimeout(() => {
        const { pending, subscribers } = setupPromptState(session.id);
        if (pending && subscribers === 0) rejectPendingSetupPrompt(session.id, "client disconnected");
      }, 20_000);
      grace.unref?.();
    };
    signal?.addEventListener("abort", disconnect, { once: true });
    const source = subscriptionEvents(writer => {
      const subscription = subscribeSetupSession(session.id, writer);
      return { ...subscription, unsubscribe() { subscription.unsubscribe(); disconnect(); } };
    }, signal);
    const work = (async () => {
      try {
      let hasFailure = false;
      /** Per-component failure reason, for the cached row below. */
      const failures = new Map<string, string>();

      for (const name of installNames) {
        if (disconnected) {
          hasFailure = true;
          updateComponentProgress(session.id, name, "failed", "Install stream disconnected before this component started");
          continue;
        }

        await authorization.authorize(ctx, { resourceType: "server", resourceId: serverId, action: "admin" });
        const failedDependencies = installPrerequisites(name).filter((dependency) =>
          failures.has(dependency),
        );
        if (failedDependencies.length > 0) {
          const msg = dependencyFailureMessage(name, failedDependencies);
          appendSetupLog(session.id, name, msg, "error");
          updateComponentProgress(session.id, name, "failed", msg);
          failures.set(name, msg);
          hasFailure = true;
          continue;
        }

        const installerFn = COMPONENT_INSTALLERS[name as keyof typeof COMPONENT_INSTALLERS];
        if (!installerFn) {
          updateComponentProgress(session.id, name, "failed", `No installer for ${name}`);
          hasFailure = true;
          continue;
        }

        updateComponentProgress(session.id, name, "installing");

        // Bind the interactive "hold" to this session so the edge installer can
        // pause on an 80/443 conflict and surface the SAME prompt modal the deploy
        // pipeline uses. Installers other than `edge` ignore it.
        const promptUser: PromptUserFn = (prompt) => promptSetupUser(session.id, prompt);

        const onLog = (log: { message: string; level: "info" | "warn" | "error" }) =>
          appendSetupLog(session.id, name, log.message, log.level);

        try {
          // A dependency inserted by the planner is not an operator request to
          // reinstall it. Probe first and skip a healthy Docker daemon, even if
          // config.reinstall was intended for the requested Edge component.
          if (!explicitlyRequested.has(name)) {
            const healthy = await sshManager.withExecutor(serverId, async (executor) => {
              const statuses = await checkComponents(executor, [name]);
              return statuses[0]?.healthy === true;
            });
            if (healthy) {
              appendSetupLog(session.id, name, `${name} is already ready; dependency satisfied`);
              updateComponentProgress(session.id, name, "installed");
              continue;
            }
          }

          // Docker is now known ready (or its failed install skipped this Edge
          // step above), so it is safe to inspect the container-backed takeover
          // journal. Doing this before the dependency loop used Docker too early.
          if (name === "edge") {
            try {
              await sshManager.withExecutor(serverId, (executor) =>
                recoverInterruptedTakeover(executor, (l) =>
                  appendSetupLog(session.id, "edge", l.message, l.level),
                ),
              );
            } catch {
              /* best-effort */
            }
          }

          const result = await sshManager.withExecutor(serverId, async (executor) => {
            await deliverEdgeBeforeInstall(name, executor, onLog);
            // Single edge-prepare point: the installer raises the edge-conflict
            // consent prompt via promptUser; on "migrate", ensureEdge runs the
            // takeover. Its InstallResult is returned unchanged when no migration.
            const edge = await ensureEdge(
              executor,
              (p) => installerFn(executor, onLog, { ...config, promptUser: p }),
              {
                promptUser,
                onLog,
                acmeEmail: config?.acmeEmail,
                nginx: {
                  ...resolveAcmeProviderOptions(),
                  ...(config?.acmeEmail ? { acmeEmail: config.acmeEmail } : {}),
                },
              },
            );
            if (!edge.migrated) return edge.value;
            return {
              component: name,
              success: edge.ok,
              error: edge.ok ? undefined : "migration failed — rolled back to the previous proxy",
            };
          });

          if (result.success) {
            appendSetupLog(session.id, name, `${name} installed successfully${result.version ? ` (${result.version})` : ""}`);
            updateComponentProgress(session.id, name, "installed");
          } else {
            const msg = result.error ?? `${name} installation failed`;
            appendSetupLog(session.id, name, msg, "error");
            updateComponentProgress(session.id, name, "failed", result.error);
            failures.set(name, msg);
            hasFailure = true;
          }
        } catch (err) {
          const msg = safeErrorMessage(err);
          appendSetupLog(session.id, name, msg, "error");
          updateComponentProgress(session.id, name, "failed", msg);
          failures.set(name, msg);
          hasFailure = true;
        }
      }

      // Write what the box now looks like into the cached edge row. Without this the
      // install told nobody: a SUCCESSFUL "Fix edge" left the stale `down` row in
      // place, so the operator refreshed and still saw "Edge down" — indistinguishable
      // from the fix having done nothing. A FAILED one lands its reason on the same
      // row, so the attention card names the cause (`bind() … Address already in use`)
      // instead of repeating "is down". Edge only: it's the sole component here that
      // has a container row (mail is provisioned by its own wizard).
      if (installNames.includes("edge")) {
        await refreshServerContainer(serverId, "edge", failures.get("edge"));
      }


        done = true;
        finishSetupSession(session.id, hasFailure ? "failed" : "completed");
      } catch (error) {
        done = true;
        const message = safeErrorMessage(error);
        appendSetupLog(session.id, "setup", message, "error");
        for (const component of session.components) if (component.status === "pending" || component.status === "installing")
          updateComponentProgress(session.id, component.name, "failed", message);
        finishSetupSession(session.id, "failed");
      } finally {
        done = true;
        signal?.removeEventListener("abort", disconnect);
        if (grace) clearTimeout(grace);
      }
    })();
    trackBackgroundWork(installations.track(work));
    audit.recordAsync(operationAuditContext(ctx), { eventType: "server:admin", resourceType: "server", resourceId: serverId });
    return source;
  },
  async monitor(ctx, serverId, signal) {
    await assertServerExecution(await requireSelfHostedServer(ctx, serverId));
    return monitorServer(serverId, signal);
  },
};

async function* monitorServer(serverId: string, signal?: AbortSignal): AsyncGenerator<DeploymentEvent> {
  const POLL_INTERVAL = 3_000;
  const STATS_TIMEOUT_MS = 12_000;
  signal?.throwIfAborted();
  sshManager.retain(serverId);
  try {
    while (!signal?.aborted) {
      try {
        // Metrics samples keep the retained non-breaking acquire/exec path.
        const executor = await sshManager.acquire(serverId);
        const raw = await executor.exec(SERVER_STATS_COMMAND, { timeout: STATS_TIMEOUT_MS });
        if (signal?.aborted) break;
        JSON.parse(raw);
        yield { event: "stats", data: raw };
      } catch (error) {
        if (signal?.aborted) break;
        yield { event: "error", data: JSON.stringify({ error: safeErrorMessage(error) }) };
      }
      await new Promise<void>(resolve => {
        if (signal?.aborted) return resolve();
        const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, POLL_INTERVAL);
        timer.unref?.();
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
  } finally { sshManager.release(serverId); }
}
