/**
 * Shared service routing helpers used by both the dashboard and API.
 */

/** Normalize any input into a valid DNS subdomain label. */
export function normalizeServiceLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";
}

/**
 * Generate the default hostname label for a service.
 * Frontend-style services use the project label directly, everything else is namespaced.
 */
export function defaultServiceHostnameLabel(projectLabel: string, serviceName: string): string {
  const base = normalizeServiceLabel(projectLabel);
  const normalizedService = normalizeServiceLabel(serviceName);

  if (["web", "app", "frontend"].includes(normalizedService)) {
    return base;
  }

  return `${base}-${normalizedService}`;
}

/** Build the public hostname label for a service, preferring the explicit saved subdomain when present. */
export function resolveServiceHostnameLabel(
  projectLabel: string,
  serviceName: string,
  explicitSubdomain?: string | null,
): string {
  return normalizeServiceLabel(explicitSubdomain || defaultServiceHostnameLabel(projectLabel, serviceName));
}