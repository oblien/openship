/**
 * WebSocket helpers - a thin wrapper around @hono/node-ws.
 *
 * The handshake `upgradeWebSocket` factory is bound to a specific Hono
 * instance, and that binding must happen AFTER `app.ts` has finished
 * constructing the Hono instance. To avoid an import cycle (this file
 * would otherwise pull `app` from `../app`, but `../app` is mid-load
 * when route modules first import this file), we use a deferred init:
 *
 *   1. `app.ts`: `setupWebSocket(app)` immediately after `new Hono()`.
 *   2. Route modules: `upgradeWebSocket(...)` at module load — safe
 *      because step 1 already ran.
 *   3. `index.ts`: `injectWebSocket(server)` after `serve()` returns
 *      the http.Server handle.
 */
import {
  currentErrorContext,
  withErrorContext,
} from "@repo/core/diagnostics/node";
import { reportError } from "@repo/core/diagnostics";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono, Context } from "hono";
import { trackBackgroundWork } from "@repo/platform/engine/lib/background-work";
import type { WSContext, WSEvents } from "hono/ws";
import type WebSocket from "ws";

type NodeWs = ReturnType<typeof createNodeWebSocket>;
type UpgradeFn = NodeWs["upgradeWebSocket"];
type InjectFn = NodeWs["injectWebSocket"];

let _upgrade: UpgradeFn | null = null;
let _inject: InjectFn | null = null;
let accepting = true;
const connections = new Set<WSContext>();

export function resumeControllerSockets(): void {
  accepting = true;
}
export function closeControllerSockets(): void {
  accepting = false;
  for (const ws of connections)
    ws.close(1012, "Instance is moving; reconnect after the handoff");
  connections.clear();
}

export function setupWebSocket(app: Hono): void {
  if (_upgrade) return; // idempotent — guards against re-init in HMR
  const ws = createNodeWebSocket({ app });
  _upgrade = ws.upgradeWebSocket;
  _inject = ws.injectWebSocket;
}

export function upgradeWebSocket(
  factory: (c: Context) => WSEvents<WebSocket> | Promise<WSEvents<WebSocket>>,
  options?: { onError: (error: unknown) => void },
) {
  if (!_upgrade) {
    throw new Error(
      "[ws] upgradeWebSocket called before setupWebSocket(app) - check that app.ts initializes WS before mounting routes.",
    );
  }
  return _upgrade(async (c) => {
    const hooks = await factory(c);
    const context = currentErrorContext();
    const invoke = (name: string, work: () => unknown) => {
      // Keep synchronous hook ordering; both throws and async rejections are
      // observed without letting an EventEmitter callback crash the server.
      withErrorContext(
        { ...context, component: "websocket", operation: name },
        () => {
          try {
            void trackBackgroundWork(Promise.resolve(work())).catch(() => {
              // diagnostics-ignore: trackBackgroundWork already records rejection.
            });
          } catch (error) {
            reportError(error, { kind: "operation", handled: true });
          }
        },
      );
    };
    return {
      ...hooks,
      onOpen: (event, ws) => {
        if (!accepting) {
          ws.close(1012, "Instance is moving");
          return;
        }
        connections.add(ws);
        invoke("websocket.open", () => hooks.onOpen?.(event, ws));
      },
      onMessage: (event, ws) => {
        if (accepting)
          invoke("websocket.message", () => hooks.onMessage?.(event, ws));
      },
      onClose: (event, ws) => {
        connections.delete(ws);
        invoke("websocket.close", () => hooks.onClose?.(event, ws));
      },
      onError: (event, ws) => {
        reportError(event, {
          ...context,
          kind: "operation",
          component: "websocket",
          handled: true,
        });
        invoke("websocket.error", () => hooks.onError?.(event, ws));
      },
    };
  }, options);
}

export const injectWebSocket: InjectFn = ((server) => {
  if (!_inject) {
    throw new Error("[ws] injectWebSocket called before setupWebSocket(app).");
  }
  return _inject(server);
}) as InjectFn;
