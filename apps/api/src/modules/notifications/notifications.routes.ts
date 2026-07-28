/**
 * Notifications routes — mounted at /api/notifications.
 *
 * Tags use the `notifications` root resource (an org singleton — see
 * route-permission.ts). The route middleware enforces that the caller
 * is a member of the active org; ownership of per-user objects
 * (channels, subscriptions, deliveries) is enforced inside handlers.
 */
import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./notifications.controller";

const r = secureRouter(new Hono(), {
  module: "notifications",
  basePath: "/api/notifications",
});


// ── Categories (static registry — readable by any member)
r.get("/categories", { tag: "notifications:read", mcp: { description: "List notification categories (the registry of event types)." } }, ctrl.listCategories);

// ── Channels (per-user)
r.get("/channels", { tag: "notifications:read", mcp: { description: "List the caller's notification channels (email, webhook, etc.)." } }, ctrl.listChannels);
r.post("/channels", { tag: "notifications:write", mcp: { description: "Create a notification channel." } }, ctrl.createChannel);
r.patch("/channels/:id", { tag: "notifications:write", mcp: { description: "Update a notification channel." } }, ctrl.updateChannel);
r.post("/channels/:id/test", { tag: "notifications:write", mcp: { description: "Send a test delivery to a channel; marks it verified on success." } }, ctrl.testChannel);
r.delete("/channels/:id", { tag: "notifications:write", mcp: { description: "Delete a notification channel." } }, ctrl.deleteChannel);

// ── Subscriptions (per-user × org)
r.get("/subscriptions", { tag: "notifications:read", mcp: { description: "List the caller's notification subscriptions." } }, ctrl.listSubscriptions);
r.put("/subscriptions", { tag: "notifications:write", mcp: { description: "Create or update a notification subscription." } }, ctrl.upsertSubscription);
r.delete("/subscriptions/:id", { tag: "notifications:write", mcp: { description: "Delete a notification subscription." } }, ctrl.deleteSubscription);

// ── Org defaults (admin-controlled — admin tag)
r.get("/defaults", { tag: "notifications:read", mcp: { description: "List org default notification settings." } }, ctrl.listDefaults);
r.put("/defaults", { tag: "notifications:admin" }, ctrl.upsertDefault);

// ── Deliveries (in-app inbox)
r.get("/deliveries", { tag: "notifications:read", mcp: { description: "List notification deliveries (the in-app alert feed)." } }, ctrl.listDeliveries);
r.get("/deliveries/unseen-count", { tag: "notifications:read", mcp: { description: "Count unseen notifications." } }, ctrl.unseenCount);
r.post("/deliveries/:id/seen", { tag: "notifications:write", mcp: { description: "Mark a notification delivery as seen." } }, ctrl.markSeen);

export const notificationsRoutes = r.hono;
