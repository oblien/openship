import { AsyncLocalStorage } from "node:async_hooks";
import { Agent } from "node:https";
import * as acme from "acme-client";
import { isValidCustomHostname, normalizeCustomHostname, safeErrorMessage } from "@repo/core";
import type { DnsCertificateProvider } from "./types";

/** Certbot's interactive hook cannot resume after the controller restarts. Use
 * ACME's order lifecycle for the manual path; the existing SSL provider still
 * validates and installs the resulting certificate on the serving host. */
type SavedOrder = {
  version: 1;
  hostname: string;
  directoryUrl: string;
  accountUrl: string;
  order: acme.Order;
  authorization: acme.Authorization;
  challenge: acme.Authorization["challenges"][number];
  csr: string;
  keyPem: string;
};

// This is acme-client's private Axios instance, not the application's HTTP
// client. Context isolates concurrent CA trust bundles and operation deadlines.
const requests = new AsyncLocalStorage<{ signal: AbortSignal; agent?: Agent }>();
acme.axios.interceptors.request.use((config) => {
  const context = requests.getStore();
  if (context) {
    config.signal = context.signal;
    config.httpsAgent = context.agent;
    config.timeout = 15_000;
    config.maxRedirects = 0;
    config.maxContentLength = 1_000_000;
  }
  return config;
});
// ACME rate limits can carry Retry-After of hours. Surface them instead of
// leaving a worker asleep; an explicit retry can resume the saved order.
(
  acme.axios.defaults as typeof acme.axios.defaults & {
    acmeSettings: { retryMaxAttempts: number };
  }
).acmeSettings.retryMaxAttempts = 0;

export interface AcmeDnsOptions {
  directoryUrl?: string;
  email?: string;
  termsOfServiceAgreed: boolean;
  eabKid?: string;
  eabHmacKey?: string;
  keyType?: "ec256" | "ec384" | "rsa2048" | "rsa4096";
  caPem?: string;
}

export function createAcmeDnsProvider(options: AcmeDnsOptions): DnsCertificateProvider {
  const directoryUrl = options.directoryUrl ?? acme.directory.letsencrypt.production;
  const url = new URL(directoryUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("ACME directory must be an HTTP(S) URL without credentials.");
  }
  const client = (accountKey: string, accountUrl?: string) =>
    new acme.Client({
      directoryUrl,
      accountKey,
      accountUrl,
      backoffAttempts: 8,
      backoffMin: 1000,
      backoffMax: 3000,
      ...(options.eabKid && options.eabHmacKey
        ? {
            externalAccountBinding: { kid: options.eabKid, hmacKey: options.eabHmacKey },
          }
        : {}),
    });
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    const agent = options.caPem ? new Agent({ ca: options.caPem }) : undefined;
    try {
      return await requests.run({ signal: AbortSignal.timeout(90_000), agent }, work);
    } catch (error) {
      const message = safeErrorMessage(error);
      throw new Error(
        options.eabHmacKey ? message.split(options.eabHmacKey).join("[REDACTED]") : message,
      );
    } finally {
      agent?.destroy();
    }
  };
  const hostnameInput = (input: string) => {
    const hostname = normalizeCustomHostname(input);
    if (!isValidCustomHostname(hostname))
      throw new Error("Enter a valid domain or wildcard hostname.");
    return hostname;
  };
  return {
    directoryUrl,
    createAccountKey: async () => (await acme.crypto.createPrivateEcdsaKey()).toString(),
    prepare: (input, accountKey) =>
      run(async () => {
        const hostname = hostnameInput(input);
        if (!options.termsOfServiceAgreed)
          throw new Error(
            "Accept the certificate authority's terms in HTTPS settings before requesting a certificate.",
          );
        const connection = client(accountKey);
        await connection.createAccount({
          termsOfServiceAgreed: true,
          ...(options.email ? { contact: [`mailto:${options.email}`] } : {}),
        });
        const order = await connection.createOrder({
          identifiers: [{ type: "dns", value: hostname }],
        });
        const authorizations = await connection.getAuthorizations(order);
        const authorization = authorizations.find(
          (item) =>
            item.identifier.value === hostname.replace(/^\*\./, "") &&
            !!item.wildcard === hostname.startsWith("*."),
        );
        const challenge = authorization?.challenges.find((item) => item.type === "dns-01");
        if (!authorization || !challenge)
          throw new Error("The certificate authority did not offer DNS-01 for this hostname.");
        const key = options.keyType?.startsWith("rsa")
          ? await acme.crypto.createPrivateRsaKey(options.keyType === "rsa4096" ? 4096 : 2048)
          : await acme.crypto.createPrivateEcdsaKey(
              options.keyType === "ec384" ? "P-384" : "P-256",
            );
        const [, csr] = await acme.crypto.createCsr(
          { commonName: hostname, altNames: [hostname] },
          key,
        );
        const state: SavedOrder = {
          version: 1,
          hostname,
          directoryUrl,
          accountUrl: connection.getAccountUrl(),
          order,
          authorization,
          challenge,
          csr: csr.toString(),
          keyPem: key.toString(),
        };
        const deadline = Math.min(
          Date.now() + 24 * 60 * 60_000,
          ...[order.expires, authorization.expires]
            .map((value) => Date.parse(value ?? ""))
            .filter(Number.isFinite),
        );
        if (deadline <= Date.now())
          throw new Error("The certificate authority returned an expired order. Try again.");
        return {
          record: {
            name: `_acme-challenge.${hostname.replace(/^\*\./, "")}`,
            value: await connection.getChallengeKeyAuthorization(challenge),
          },
          expiresAt: new Date(deadline).toISOString(),
          state: JSON.stringify(state),
        };
      }),
    complete: (input, accountKey, serialized) =>
      run(async () => {
        const hostname = hostnameInput(input);
        const saved = JSON.parse(serialized) as SavedOrder;
        if (
          saved.version !== 1 ||
          saved.hostname !== hostname ||
          saved.directoryUrl !== directoryUrl
        ) {
          throw new Error(
            "The domain or certificate authority changed. Start a new TXT challenge.",
          );
        }
        const connection = client(accountKey, saved.accountUrl);
        let order = await connection.getOrder(saved.order);
        if (order.status === "invalid")
          throw new Error("The certificate order is no longer valid. Start a new TXT challenge.");
        if (order.status === "pending") {
          const authorizations = await connection.getAuthorizations(order);
          const authorization = authorizations.find((item) => item.url === saved.authorization.url);
          const challenge = authorization?.challenges.find(
            (item) => item.url === saved.challenge.url,
          );
          if (!authorization || !challenge)
            throw new Error(
              "The DNS challenge changed. Start again to get the current TXT record.",
            );
          if (authorization.status !== "valid") {
            if (challenge.status === "pending") await connection.completeChallenge(challenge);
            await connection.waitForValidStatus(authorization);
          }
          order = await connection.getOrder(order);
        }
        if (order.status === "ready") order = await connection.finalizeOrder(order, saved.csr);
        if (order.status !== "valid") order = await connection.waitForValidStatus(order);
        return { certPem: await connection.getCertificate(order), keyPem: saved.keyPem };
      }),
  };
}
