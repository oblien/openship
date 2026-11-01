import type { IncomingWebhookActionConfig } from "@repo/db";

import { MAX_DEPLOY_SERVICE_TARGETS } from "@repo/core";
export { MAX_DEPLOY_SERVICE_TARGETS } from "@repo/core";

/** Resolve and validate the new plural target first while retaining old
 * singular webhook rows. A caller that explicitly supplied `serviceIds` must
 * never collapse to `undefined`: that means "whole project" to the deployment
 * API and would turn malformed input into a much broader deploy. */
export function deployServiceIds(config: IncomingWebhookActionConfig): string[] | undefined {
  if (config.serviceIds !== undefined) {
    if (!Array.isArray(config.serviceIds) || config.serviceIds.length === 0) {
      throw new Error("Webhook deploy serviceIds must contain at least one service");
    }
    if (config.serviceIds.length > MAX_DEPLOY_SERVICE_TARGETS) {
      throw new Error(
        `Webhook deploy serviceIds cannot contain more than ${MAX_DEPLOY_SERVICE_TARGETS} services`,
      );
    }

    const ids = config.serviceIds.map((id) => {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("Webhook deploy serviceIds must contain non-empty service IDs");
      }
      return id.trim();
    });
    if (new Set(ids).size !== ids.length) {
      throw new Error("Webhook deploy serviceIds must not contain duplicate service IDs");
    }
    return ids;
  }
  if (config.serviceId !== undefined) {
    // The original API accepted an empty singular value and dispatch treated it
    // exactly like an omitted target (whole project). Existing JSONB rows can
    // therefore legitimately contain `serviceId: ""`. Preserve that stored-row
    // behavior while the current request schema rejects new blank values.
    if (config.serviceId === "") return undefined;
    if (typeof config.serviceId !== "string" || !config.serviceId.trim()) {
      throw new Error("Webhook deploy serviceId must be a non-empty service ID");
    }
    return [config.serviceId.trim()];
  }
  return undefined;
}

/** Persist one unambiguous representation. New plural input wins over the
 * legacy field; legacy rows stay singular so old clients continue to work. */
export function normalizeDeployActionConfig(
  config: IncomingWebhookActionConfig,
): IncomingWebhookActionConfig {
  const ids = deployServiceIds(config);
  if (config.serviceIds !== undefined) return { serviceIds: ids };
  return ids ? { serviceId: ids[0] } : {};
}
