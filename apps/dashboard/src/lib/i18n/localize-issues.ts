/**
 * Localizes diagnostic messages, certbot / Let's Encrypt / DNS error strings,
 * and system issue copy.
 */

export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

export function localizeActionLabel(
  label: string,
  actions?: Record<string, string>,
): string {
  if (!actions) return label;
  if (label === "Retry routing") return actions.retryRouting ?? label;
  if (label === "Verify DNS") return actions.verifyDns ?? label;
  if (label === "Renew certificate") return actions.renewCert ?? label;
  if (label === "Re-check certificate") return actions.recheckCert ?? label;
  if (label === "Redeploy") return actions.redeploy ?? label;
  if (label === "Keep") return actions.keep ?? label;
  if (label === "Reject and roll back") return actions.rejectRollback ?? label;
  if (label === "Dismiss warning") return actions.dismiss ?? label;
  return label;
}

export function localizeIssueTitle(
  rawTitle: string,
  titles?: Record<string, string>,
): string {
  if (!titles) return rawTitle;
  if (rawTitle === "Routing didn't sync")
    return titles.routingUnsynced ?? rawTitle;
  const unverified = rawTitle.match(/^(.*) isn't verified$/);
  if (unverified) {
    return titles.domainUnverified
      ? interpolate(titles.domainUnverified, { hostname: unverified[1] })
      : rawTitle;
  }
  const certExpire = rawTitle.match(/^The certificate for (.*) expired$/);
  if (certExpire) {
    return titles.certExpired
      ? interpolate(titles.certExpired, { hostname: certExpire[1] })
      : rawTitle;
  }
  const certFail = rawTitle.match(/^The certificate for (.*) failed$/);
  if (certFail) {
    return titles.certFailed
      ? interpolate(titles.certFailed, { hostname: certFail[1] })
      : rawTitle;
  }
  if (rawTitle === "Some services failed — keep or reject this release") {
    return titles.partialDecision ?? rawTitle;
  }
  const portMatch = rawTitle.match(/^Port (\d+) in use$/);
  if (portMatch) {
    return titles.portInUse
      ? interpolate(titles.portInUse, { port: portMatch[1] })
      : rawTitle;
  }
  return rawTitle;
}

/**
 * Localizes server-side and certbot/DNS diagnostic error strings.
 */
export function localizeDiagnosisMessage(
  rawMsg: string | null | undefined,
  msgs?: Record<string, string>,
): string {
  if (!rawMsg) return "";
  if (!msgs) return rawMsg;

  // Preserve trailing " — Detail: ..." or " — Hint: ..." parts for debugging
  const tailParts: string[] = [];
  let text = rawMsg.trim();
  while (true) {
    const tailMatch = text.match(/\s*—\s*((?:Detail|Hint):\s*.+)$/i);
    if (tailMatch && tailMatch.index !== undefined) {
      tailParts.unshift(tailMatch[1]);
      text = text.slice(0, tailMatch.index).trim();
    } else {
      break;
    }
  }

  // Check for redundant leading "domain: "
  const prefixMatch = text.match(/^([a-zA-Z0-9.-]+):\s+(.*)$/);
  const core = prefixMatch ? prefixMatch[2] : text;

  let localizedCore: string | undefined;

  // 1. DNS A record missing or unresolved / NXDOMAIN
  const dnsMatch = core.match(
    /^(.*?)\s+doesn't resolve to this server yet — the DNS A record is missing or hasn't propagated\. Wait for propagation, then retry from the Domains tab\.?$/i,
  );
  if (dnsMatch && msgs.certDnsUnresolved) {
    localizedCore = interpolate(msgs.certDnsUnresolved, {
      domain: dnsMatch[1],
    });
  }

  // 2. Port 80 unreachable from the internet
  if (!localizedCore) {
    const p80Match = core.match(
      /^Port 80 for (.*?)\s+isn't reachable from the internet — a firewall \/ cloud security group is blocking it, the domain doesn't point at this server, or another proxy is still bound to :80\.?$/i,
    );
    if (p80Match && msgs.certPort80Unreachable) {
      localizedCore = interpolate(msgs.certPort80Unreachable, {
        domain: p80Match[1],
      });
    }
  }

  // 3. Cloudflare proxy answering certificate challenge
  if (!localizedCore) {
    const cfMatch = core.match(
      /^Cloudflare's proxy is answering the certificate challenge for (.*?)\s+instead of forwarding it to this server:.*$/i,
    );
    if (cfMatch && msgs.certCloudflareProxy) {
      localizedCore = interpolate(msgs.certCloudflareProxy, {
        domain: cfMatch[1],
      });
    }
  }

  // 4. Redirected from HTTP to HTTPS and answered with 404
  if (!localizedCore) {
    const redMatch = core.match(
      /^The challenge for (.*?)\s+was redirected from HTTP to HTTPS and then answered with a 404 — so whatever served it isn't routing that hostname\..*$/i,
    );
    if (redMatch && msgs.certRedirect404) {
      localizedCore = interpolate(msgs.certRedirect404, {
        domain: redMatch[1],
      });
    }
  }

  // 5. Port 80 answered but not with our ACME challenge
  if (
    !localizedCore &&
    /Port 80 answered but not with our ACME challenge/i.test(core)
  ) {
    if (msgs.certPort80NotAcme) {
      localizedCore = msgs.certPort80NotAcme;
    }
  }

  // 6. Let's Encrypt rate limit reached
  if (!localizedCore) {
    const rateMatch = core.match(
      /^Let's Encrypt rate limit reached for (.*?)\s+— wait before retrying\.?$/i,
    );
    if (rateMatch && msgs.certRateLimited) {
      localizedCore = interpolate(msgs.certRateLimited, {
        domain: rateMatch[1],
      });
    }
  }

  // 7. Port bind failure
  if (!localizedCore) {
    const bindMatch = core.match(
      /^Couldn't start the certificate challenge listener for (.*?) on port (\d+):.*$/i,
    );
    if (bindMatch && msgs.certPortBindFailure) {
      localizedCore = interpolate(msgs.certPortBindFailure, {
        domain: bindMatch[1],
        port: bindMatch[2],
      });
    }
  }

  // 8. Generic certbot failure
  if (!localizedCore) {
    const genMatch = core.match(
      /^certbot failed to issue a certificate for (.*?)$/i,
    );
    if (genMatch && msgs.certFailedGeneric) {
      localizedCore = interpolate(msgs.certFailedGeneric, {
        domain: genMatch[1],
      });
    }
  }

  // 9. Common system / network failure texts
  if (!localizedCore) {
    if (
      core === "Request timed out. The server took too long to respond." &&
      msgs.requestTimeout
    ) {
      localizedCore = msgs.requestTimeout;
    } else if (core === "Request cancelled." && msgs.requestCancelled) {
      localizedCore = msgs.requestCancelled;
    } else if (core === "Request failed" && msgs.requestFailed) {
      localizedCore = msgs.requestFailed;
    } else if (
      core ===
        "Cannot reach Openship. Check the connection and server availability." &&
      msgs.networkUnreachable
    ) {
      localizedCore = msgs.networkUnreachable;
    } else if (core === "Host is not reachable" && msgs.hostUnreachable) {
      localizedCore = msgs.hostUnreachable;
    } else if (core === "SSH connection refused" && msgs.sshConnectionRefused) {
      localizedCore = msgs.sshConnectionRefused;
    }
  }

  if (!localizedCore) {
    return rawMsg;
  }

  if (tailParts.length > 0) {
    return [localizedCore, ...tailParts].join(" — ");
  }

  return localizedCore;
}

export function localizeIssueMessage(
  rawMsg: string,
  msgs?: Record<string, string>,
): string {
  if (!msgs) return rawMsg;
  if (
    rawMsg ===
    "DNS for this hostname hasn't verified yet. Check the records, then re-run the check."
  ) {
    return msgs.domainDnsUnverified ?? rawMsg;
  }
  if (
    rawMsg ===
    "The deploy succeeded but its edge route didn't sync, so the public URL may not resolve yet. Retrying re-runs just the routing step — it does not rebuild."
  ) {
    return msgs.routingUnsynced ?? rawMsg;
  }
  if (
    rawMsg ===
    "HTTPS will fail for this hostname until a certificate is issued. Renewing re-runs issuance."
  ) {
    return msgs.certHttpsWillFail ?? rawMsg;
  }
  if (
    rawMsg.startsWith(
      "Some services failed to come up. The rest are live. Keep the release, or reject it to roll back to the previous one.",
    )
  ) {
    return msgs.partialServices ?? rawMsg;
  }
  const partNamed = rawMsg.match(
    /^These services failed: (.*?)\. The rest are live\. Keep the release, or reject it to roll back to the previous one\.$/,
  );
  if (partNamed) {
    return msgs.partialNamedServices
      ? interpolate(msgs.partialNamedServices, { services: partNamed[1] })
      : rawMsg;
  }
  if (rawMsg === "No usable HTTPS certificate was found on the server.") {
    return msgs.noCertOnServer ?? rawMsg;
  }
  if (rawMsg === "DNS points to a different server") {
    return msgs.dnsOtherServer ?? rawMsg;
  }
  if (rawMsg === "Ownership TXT record missing") {
    return msgs.txtMissing ?? rawMsg;
  }
  if (rawMsg === "The mail certificate has expired.") {
    return msgs.mailCertExpired ?? rawMsg;
  }
  const certEdge = rawMsg.match(
    /^Couldn't confirm a certificate \((.*?)\)\. Make sure the domain points at this server/,
  );
  if (certEdge) {
    return msgs.certEdgeFailed
      ? interpolate(msgs.certEdgeFailed, { detail: certEdge[1] })
      : rawMsg;
  }

  // Fallback to certbot and system diagnostic localization
  return localizeDiagnosisMessage(rawMsg, msgs);
}
