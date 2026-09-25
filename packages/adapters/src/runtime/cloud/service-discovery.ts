import { isIP } from "node:net";
import { isValidServiceName, shellQuote } from "@repo/core";

/** Only data reaches the shell: no fixed heredoc delimiter can be closed by a
 * service name, address or legacy group identifier. Validate before any writes. */
export function renderServiceDiscoveryScript(
  groupId: string,
  services: { serviceName: string; ip: string }[],
): string {
  if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(groupId)) throw new Error("Invalid service discovery group.");
  for (const service of services) {
    if (!isValidServiceName(service.serviceName) || !isIP(service.ip)) {
      throw new Error("Invalid service discovery name or address.");
    }
  }
  const marker = ` # openship-compose:${groupId}`;
  const block = services.map(service => `${service.ip} ${service.serviceName}${marker}`).join("\n");
  return `set -e
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
awk -v marker=${shellQuote(marker)} 'substr($0, length($0) - length(marker) + 1) != marker' /etc/hosts > "$tmp"
printf '%s\\n' ${shellQuote(block)} >> "$tmp"
cat "$tmp" > /etc/hosts`;
}
