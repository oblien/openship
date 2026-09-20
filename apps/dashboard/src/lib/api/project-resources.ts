import type { ProjectResources } from "@repo/core";

/**
 * The `success` marker was added after the resources endpoint shipped. Keep it
 * optional so a newer dashboard can still talk to an older API during rolling
 * upgrades; an explicit `false` is always a failure.
 */
export interface ProjectResourcesResponse {
  success: true;
  data: ProjectResources;
}

interface ProjectResourcesWireResponse {
  success?: unknown;
  data?: unknown;
  error?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalize the API boundary once instead of teaching every
 * component about the legacy `{ data }` and current `{ success: true, data }`
 * envelopes.
 */
export function normalizeProjectResourcesResponse(response: unknown): ProjectResourcesResponse {
  if (!isRecord(response)) {
    throw new Error("The resources API returned an invalid response.");
  }

  const envelope = response as ProjectResourcesWireResponse;
  if (envelope.success !== undefined && typeof envelope.success !== "boolean") {
    throw new Error("The resources API returned an invalid response.");
  }

  if (envelope.success === false) {
    const message =
      typeof envelope.message === "string"
        ? envelope.message
        : typeof envelope.error === "string"
          ? envelope.error
          : "Request failed";
    throw new Error(message);
  }

  if (!isRecord(envelope.data)) {
    throw new Error("The resources API returned an invalid response.");
  }

  return { success: true, data: envelope.data as unknown as ProjectResources };
}
