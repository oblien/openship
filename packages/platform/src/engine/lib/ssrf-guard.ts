/** Shared outbound target validation. HTTP and TLS use the same DNS pinning policy. */
export {
  SsrfError, isPrivateIp, isBlockedHostname, assertPublicHostLiteral,
  assertPublicUrlLiteral, assertPublicHost, resolvePinnedHost, assertPublicUrl,
} from "@repo/adapters/outbound-target";
