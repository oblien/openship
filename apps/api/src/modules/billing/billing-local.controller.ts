/**
 * Local billing controller — runs only when !CLOUD_MODE.
 *
 * Proxies billing operations to the SaaS API via cloudBillingFetch,
 * following the same pattern as cloud-local.controller.ts.
 *
 * The user's cloud session is server-side only (encrypted in DB).
 * Dynamic import ensures cloud-client is never loaded in SaaS mode.
 */

import type { Context } from "hono";
import { getUserId } from "../../lib/controller-helpers";

/**
 * Forward a billing request to the SaaS API.
 * Returns 403 if the user isn't connected to Openship Cloud.
 */
async function proxyToCloud(
  c: Context,
  path: string,
  method: string = "GET",
) {
  const userId = getUserId(c);
  const body = method !== "GET" ? await c.req.text() : undefined;

  const { cloudBillingFetch } = await import("../../lib/cloud-client");
  const res = await cloudBillingFetch(userId, path, { method, body });

  if (!res) {
    return c.json({ error: "Not connected to Openship Cloud" }, 403);
  }

  const data = await res.json();
  return c.json(data, res.status as 200);
}

/* ---------- Subscriptions ---------- */

export async function getSubscription(c: Context) {
  return proxyToCloud(c, "/subscription");
}

export async function createSubscription(c: Context) {
  return proxyToCloud(c, "/subscription", "POST");
}

export async function updateSubscription(c: Context) {
  return proxyToCloud(c, "/subscription", "PATCH");
}

export async function cancelSubscription(c: Context) {
  return proxyToCloud(c, "/subscription", "DELETE");
}

/* ---------- Usage ---------- */

export async function getUsage(c: Context) {
  return proxyToCloud(c, "/usage");
}

/* ---------- Payment Methods ---------- */

export async function listPaymentMethods(c: Context) {
  return proxyToCloud(c, "/payment-methods");
}

export async function addPaymentMethod(c: Context) {
  return proxyToCloud(c, "/payment-methods", "POST");
}

/* ---------- Invoices ---------- */

export async function listInvoices(c: Context) {
  return proxyToCloud(c, "/invoices");
}
