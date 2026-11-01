import { UnauthorizedError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { auth } from "@repo/platform/engine/lib/auth";
import { authorization } from "@repo/platform/engine/lib/authorization";
import {
  captureExecutionAuthority,
  resolveExecutionAuthority,
} from "@repo/platform/engine/lib/execution-authority";
import { resolveActiveOrganizationId } from "../middleware/active-organization";
import { reportCaughtError } from "@repo/core/diagnostics";

/** Both terminal transports preserve the original credential across upgrades.
 * The shared delegation resolver rechecks revocation, expiry, current grants
 * and membership. A bad ticket must never fall back to cookie authorization. */
export async function resolveTerminalContext(
  headers: Headers,
  ticketContext?: ExecutionContext,
): Promise<ExecutionContext> {
  if (ticketContext) return refreshTerminalContext(ticketContext);
  const session = await auth.api.getSession({ headers });
  if (!session?.user?.id) throw new UnauthorizedError();
  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  );
  if (!organizationId) throw new UnauthorizedError();
  const ctx = await authorization.resolveScope(
    {
      user: session.user,
      sessionId: session.session.id,
      sessionKind: "cookie",
    },
    organizationId,
  );
  return authorization.authorize(ctx, {
    resourceType: "terminal",
    resourceId: "*",
    action: "write",
  });
}

/** Reuse the saved-action policy; do not build a second token validator. */
export async function refreshTerminalContext(ctx: ExecutionContext): Promise<ExecutionContext> {
  // Saved actions deliberately outlive a login. Interactive terminals must not:
  // a revoked/expired browser or bearer session also ends its open shells.
  if (!ctx.principalKind && (ctx.sessionKind === "cookie" || ctx.sessionKind === "bearer")) {
    const session = await repos.session.findById(ctx.sessionId);
    if (!session || session.userId !== ctx.userId || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError();
    }
  }
  const current = await resolveExecutionAuthority(await captureExecutionAuthority(ctx), "terminal");
  return authorization.authorize(current, {
    resourceType: "terminal",
    resourceId: "*",
    action: "write",
  });
}

/** Recheck long-lived local shells too, without a database query per keystroke.
 * Detached sessions require a new authorized handshake before they can resume. */
export function watchTerminalAuthorization(
  ctx: ExecutionContext,
  resource: { resourceType: "server" | "project"; resourceId: string },
  onDenied: () => void,
): () => void {
  let stopped = false;
  let checking = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void (async () => {
      let allowed = false;
      try {
        const current = await refreshTerminalContext(ctx);
        allowed = await authorization.checkPermissionOnResource(current, {
          ...resource,
          action: "admin",
        });
      } catch (error) {
        reportCaughtError(error, "api/lib/terminal-authorization");
      }
      if (!stopped && !allowed) {
        stop();
        onDenied();
      }
    })().finally(() => {
      checking = false;
    });
  }, 5_000);
  timer.unref?.();
  return stop;
}
