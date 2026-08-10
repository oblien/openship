/**
 * Mail-server routing - pure module.
 *
 * The route+DNS plan model that describes how openship's routing layer should
 * front a self-hosted mail server. Contains no I/O, no platform calls, no DB
 * - safe to import from any context (apps/api, dashboard UI, CLI tools,
 * scripts) without pulling in transitive dependencies.
 *
 * The matching side-effecting glue (calling the platform's RoutingProvider to
 * actually register routes) lives in `apps/api/src/modules/mail-server/routing/`.
 */

export * from "./types";
export { buildMailServerRoutes, mailServerRouteHostnames } from "./build-routes";
