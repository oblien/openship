import { connect, checkServerIdentity, type TLSSocket } from "node:tls";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { SslResult } from "../types";
import { resolvePinnedHost } from "./outbound-target";

const certificateErrors = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_REVOKED",
  "INVALID_CA",
]);

/** Inspect what a browser receives. No HTTP requests, redirects, credentials,
 * route changes or certificate issuance. DNS and TLS share one deadline. */
export async function probePublicTlsCertificate(
  hostname: string,
  timeoutMs = 5_000,
): Promise<SslResult> {
  const domain = hostname.trim().toLowerCase();
  const unknown: SslResult = {
    domain,
    verified: false,
    expiresAt: "",
    issuer: "",
    reason: "read_error",
    detail: "HTTPS could not be checked from Openship. Check the connection and retry.",
  };
  // A wildcard is a certificate pattern, not an address that can be dialled.
  if (!domain || domain.includes("*") || /[\s/:@\\]/.test(domain)) return unknown;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("TLS check timed out")), timeoutMs);
  let socket: TLSSocket | undefined;
  const aborted = () => socket?.destroy(new Error("TLS check timed out"));
  controller.signal.addEventListener("abort", aborted, { once: true });
  try {
    const { ip } = await resolvePinnedHost(domain, false, controller.signal);
    controller.signal.throwIfAborted();
    return await new Promise<SslResult>((resolve, reject) => {
      socket = connect({
        host: ip,
        port: 443,
        servername: domain,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(domain, certificate),
      });
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        const certificate = socket!.getPeerCertificate();
        const expiry = Date.parse(certificate.valid_to);
        const validFrom = Date.parse(certificate.valid_from);
        const valid =
          socket!.authorized &&
          Number.isFinite(expiry) &&
          Number.isFinite(validFrom) &&
          validFrom <= Date.now() &&
          expiry > Date.now();
        resolve({
          domain,
          verified: valid,
          expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : "",
          issuer: String(certificate.issuer?.O ?? certificate.issuer?.CN ?? ""),
          reason: valid ? "issued" : "edge_invalid",
          ...(!valid
            ? { detail: "The certificate served for this hostname is expired or not yet valid." }
            : {}),
        });
      });
    });
  } catch (error) {
    observeCaughtError(error, "adapters/system/tls-probe");
    const code = (error as { code?: string })?.code;
    if (code && certificateErrors.has(code))
      return {
        ...unknown,
        reason: "edge_invalid",
        detail:
          code === "ERR_TLS_CERT_ALTNAME_INVALID"
            ? "The edge is serving a certificate for a different hostname. The provider must correct its certificate binding."
            : "The edge is serving a certificate that browsers cannot trust or that is outside its validity period.",
      };
    return unknown;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", aborted);
    socket?.destroy();
  }
}
