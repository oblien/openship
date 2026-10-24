import {
  coerceProxyValue,
  PROXY_DIRECTIVE_BY_KEY,
  sanitizeProxySettings,
  type ProxySettings,
} from "./proxy-settings";

/** The only per-domain proxy setting supported by the public contract. */
export type DomainProxySettings = Pick<ProxySettings, "clientMaxBodySize">;

/** Strict admission for untrusted imports; rendering sanitization is separate. */
export function isDomainProxySettings(input: unknown): input is DomainProxySettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "clientMaxBodySize") &&
    (!Object.hasOwn(record, "clientMaxBodySize") ||
      coerceProxyValue(
        PROXY_DIRECTIVE_BY_KEY.get("clientMaxBodySize")!,
        record.clientMaxBodySize,
      ) !== undefined)
  );
}

/** Defense in depth for imported/persisted JSON before it reaches the renderer. */
export function sanitizeDomainProxySettings(input: unknown): DomainProxySettings | undefined {
  const value = sanitizeProxySettings(input)?.clientMaxBodySize;
  return value === undefined ? undefined : { clientMaxBodySize: value };
}

/** Leave an unset cap unset: nginx inherits the installed Edge HTTP default. */
export function resolveDomainProxySettings(
  projectProxy: unknown,
  domainProxy: unknown,
): ProxySettings | undefined {
  const project = sanitizeProxySettings(projectProxy);
  const domain = sanitizeDomainProxySettings(domainProxy);
  return project || domain ? { ...project, ...domain } : undefined;
}
