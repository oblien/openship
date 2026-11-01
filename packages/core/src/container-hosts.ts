import { ValidationError } from "./errors";

export const CONTAINER_HOST_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}(?![\\s\\S])";
const hostnamePattern = new RegExp(CONTAINER_HOST_PATTERN);

function addressIsValid(value: string): boolean {
  if (value === "host-gateway") return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part);
  }
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    // diagnostics-ignore: URL rejection is an expected invalid-address result.
    return false;
  }
}

/** Docker/Compose host aliases. Both importers and writes use this validation;
 * aliases change the connection address without changing its TLS hostname. */
export function parseContainerHosts(
  raw: unknown,
  interpolate: (value: string) => string = (value) => value,
): Record<string, string> | undefined {
  if (raw == null) return undefined;
  const entries: [string, unknown][] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string")
        throw new ValidationError("extra_hosts entries must be strings");
      const resolved = interpolate(item);
      const separator = resolved.includes("=") ? resolved.indexOf("=") : resolved.indexOf(":");
      if (separator < 1) throw new ValidationError("extra_hosts entries must be hostname=address");
      entries.push([resolved.slice(0, separator), resolved.slice(separator + 1)]);
    }
  } else if (typeof raw === "object") {
    entries.push(
      ...Object.entries(raw).map(([key, value]): [string, unknown] => [
        key,
        typeof value === "string" ? interpolate(value) : value,
      ]),
    );
  } else {
    throw new ValidationError("extra_hosts must be a hostname/address map or list");
  }
  if (entries.length > 100) throw new ValidationError("extra_hosts supports at most 100 aliases");
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!hostnamePattern.test(key) || typeof rawValue !== "string") {
      throw new ValidationError("extra_hosts requires valid hostnames and string addresses");
    }
    const host = key.toLowerCase();
    const value = rawValue.trim().replace(/^\[([^\]]+)\]$/, "$1");
    if (value.length > 64 || !addressIsValid(value)) {
      throw new ValidationError("extra_hosts addresses must be IPv4, IPv6 or host-gateway");
    }
    if (Object.hasOwn(result, host) && result[host] !== value) {
      throw new ValidationError("extra_hosts declares conflicting addresses for one hostname");
    }
    Object.defineProperty(result, host, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
