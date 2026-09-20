/**
 * Parse a dotted IPv4 literal without accepting partial, octal, or out-of-range
 * forms. URL callers receive a normalized dotted address; direct callers still
 * get a conservative and predictable predicate.
 */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(?:0|[1-9]\d{0,2})$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

/** Expand an IPv6 literal into its eight 16-bit words. */
function ipv6Words(host: string): number[] | null {
  let value = host;
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);

  const dottedTail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  if (dottedTail) {
    const octets = ipv4Octets(dottedTail);
    if (!octets) return null;
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:${(
      (octets[2] << 8) |
      octets[3]
    ).toString(16)}`;
    value = value.slice(0, -dottedTail.length) + replacement;
  }

  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = value.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;

  const compressed = value.includes("::");
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null;
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
}

/**
 * Whether connecting to this host stays in the caller's own network namespace.
 *
 * This intentionally includes the unspecified addresses (`0.0.0.0` / `::`):
 * Linux accepts them as connect targets for local listeners, so treating them as
 * public would let an untrusted proxy rule bypass a loopback-only safety gate.
 * IPv4-mapped/compatible IPv6 forms are covered as well.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  value = value.replace(/\.+$/, "");
  if (!value) return false;

  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "localhost.localdomain" ||
    value === "ip6-localhost" ||
    value === "ip6-loopback"
  ) {
    return true;
  }

  const ipv4 = ipv4Octets(value);
  if (ipv4) return ipv4[0] === 127 || ipv4.every((octet) => octet === 0);

  const words = ipv6Words(value);
  if (!words) return false;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;

  // ::ffff:127.0.0.0/8 (mapped) and ::127.0.0.0/8 (compatible).
  const ipv4PrefixIsLocal = words[6]! >> 8 === 127;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every((word) => word === 0);
  return ipv4PrefixIsLocal && (mapped || compatible);
}
