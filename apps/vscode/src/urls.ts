/** Configured endpoints must never carry credentials or change SDK routing. */
export function normalizeEndpoint(input: string): string {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an HTTP or HTTPS URL without credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

export function endpointError(input: string): string | undefined {
  try {
    normalizeEndpoint(input);
  } catch {
    return "Enter an HTTP or HTTPS URL without credentials, a query, or a fragment.";
  }
}

export function dashboardUrl(base: string, projectId?: string, deploymentId?: string): string {
  const path = deploymentId
    ? `/build/${encodeURIComponent(deploymentId)}`
    : projectId
      ? `/projects/${encodeURIComponent(projectId)}`
      : "";
  return normalizeEndpoint(base) + path;
}

export function applicationUrl(input: string): string {
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The application URL must use HTTP or HTTPS without embedded credentials.");
  }
  return url.href;
}
