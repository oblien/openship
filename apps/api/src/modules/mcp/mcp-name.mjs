/** Shared by runtime discovery and the static website reference. */
export function mcpToolName(method, path) {
  const segments = path
    .split("/")
    .filter((segment) => segment && segment !== "api")
    .map((segment) =>
      segment.startsWith(":") ? `by_${segment.slice(1)}` : segment.replace(/[^a-z0-9]+/gi, "_"),
    );
  return [method.toLowerCase(), ...segments].join("_").replace(/_+/g, "_").slice(0, 64);
}
