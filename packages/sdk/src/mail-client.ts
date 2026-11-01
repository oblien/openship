import {
  MailScopedSchemas,
  MailServerSchemas,
  MailDomainSchemas,
  MailMailboxSchemas,
  MailAliasSchemas,
  MailInboundSchemas,
  MailComponentSchemas,
  MailRequestSchemas,
  parseInput,
  type MailOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import {
  createRemoteScopedOperations,
  createRemoteResourceOperations,
  createRemoteChildResourceOperations,
} from "./resource-client";

/** Transport only. Mail ownership, provisioning, DNS and certificate renewal remain in the existing API/engine. */
export function createRemoteMailOperations(http: HttpClient): MailOperations {
  const server = (id: string) => `/mail/admin/${encodeURIComponent(id)}`;
  const domain = (id: string, name: string) => `${server(id)}/domains/${encodeURIComponent(name)}`;
  const mailbox = (id: string, email: string) =>
    `${server(id)}/mailboxes/${encodeURIComponent(email)}`;
  const alias = (id: string, aliasId: string) =>
    `${server(id)}/aliases/${encodeURIComponent(aliasId)}`;
  const rule = (id: string, ruleId: string) =>
    `${server(id)}/inbound-rules/${encodeURIComponent(ruleId)}`;
  const component = (id: string, key: string) =>
    `${server(id)}/components/${encodeURIComponent(key)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, MailScopedSchemas, {
      getSteps: { method: "GET", path: () => "/mail/steps" },
      getStatus: { method: "GET", path: () => "/mail/status", redactInvalidResponse: true },
      listServers: { method: "GET", path: () => "/mail/servers", envelope: "servers" },
      scan: { method: "POST", path: () => "/mail/scan" },
      adopt: { method: "POST", path: () => "/mail/adopt" },
      cancelSetup: { method: "POST", path: () => "/mail/setup/cancel" },
      acknowledgeDns: { method: "POST", path: () => "/mail/setup/dns-ack" },
      acknowledgePtr: { method: "POST", path: () => "/mail/setup/ptr-ack" },
      resetSetup: { method: "POST", path: () => "/mail/setup/reset" },
      setPostmasterPassword: {
        method: "POST",
        path: () => "/mail/credentials/postmaster",
        redactInvalidResponse: true,
      },
      getWebmailTargets: {
        method: "GET",
        path: () => "/mail/webmail/targets",
        envelope: "options",
      },
      deployWebmail: { method: "POST", path: () => "/mail/webmail/deploy-project" },
      deployExternalWebmail: { method: "POST", path: () => "/mail/webmail/deploy-external" },
    }),
    ...createRemoteResourceOperations(http, MailServerSchemas, {
      forget: { method: "DELETE", path: (id) => `/mail/servers/${encodeURIComponent(id)}` },
      getHealth: { method: "GET", path: (id) => `/mail/health/${encodeURIComponent(id)}` },
      getCertificate: { method: "GET", path: (id) => `${server(id)}/certificate` },
      checkCertificate: { method: "POST", path: (id) => `${server(id)}/certificate/check` },
      renewCertificate: { method: "POST", path: (id) => `${server(id)}/certificate/renew` },
      updateCertificate: { method: "PATCH", path: (id) => `${server(id)}/certificate` },
      listDomains: { method: "GET", path: (id) => `${server(id)}/domains`, envelope: "domains" },
      createDomain: { method: "POST", path: (id) => `${server(id)}/domains` },
      pendingDomainDns: {
        method: "GET",
        path: (id) => `${server(id)}/domains-dns/pending`,
        envelope: "pending",
      },
      listMailboxes: {
        method: "GET",
        path: (id) => `${server(id)}/mailboxes`,
        envelope: "mailboxes",
        redactInvalidResponse: true,
      },
      createMailbox: {
        method: "POST",
        path: (id) => `${server(id)}/mailboxes`,
        envelope: "mailbox",
        redactInvalidResponse: true,
      },
      rotatePlatformMailbox: {
        method: "POST",
        path: (id) => `${server(id)}/platform-mailbox/rotate`,
        redactInvalidResponse: true,
      },
      listAliases: { method: "GET", path: (id) => `${server(id)}/aliases`, envelope: "aliases" },
      createAlias: { method: "POST", path: (id) => `${server(id)}/aliases`, envelope: "alias" },
      getStats: { method: "GET", path: (id) => `${server(id)}/stats` },
      getBackupPolicy: {
        method: "GET",
        path: (id) => `${server(id)}/backup-policy`,
        envelope: "policy",
      },
      saveBackupPolicy: {
        method: "POST",
        path: (id) => `${server(id)}/backup-policy`,
        envelope: "policy",
      },
      listBackupRuns: {
        method: "GET",
        path: (id) => `${server(id)}/backup-runs`,
        envelope: "runs",
      },
      scanDns: { method: "GET", path: (id) => `${server(id)}/dns-scan` },
      getRelay: {
        method: "GET",
        path: (id) => `${server(id)}/relay`,
        envelope: "relay",
        redactInvalidResponse: true,
      },
      configureRelay: {
        method: "POST",
        path: (id) => `${server(id)}/relay`,
        envelope: "relay",
        redactInvalidResponse: true,
      },
      removeRelay: { method: "DELETE", path: (id) => `${server(id)}/relay` },
      sendTestEmail: { method: "POST", path: (id) => `${server(id)}/test-email` },
      restartComponents: { method: "POST", path: (id) => `${server(id)}/components/restart-all` },
      listInboundRules: {
        method: "GET",
        path: (id) => `${server(id)}/inbound-rules`,
        envelope: "rules",
      },
      createInboundRule: {
        method: "POST",
        path: (id) => `${server(id)}/inbound-rules`,
        envelope: "rule",
      },
      testInboundRules: { method: "POST", path: (id) => `${server(id)}/inbound-rules/test` },
    }),
    ...createRemoteChildResourceOperations(http, MailDomainSchemas, {
      getDomain: { method: "GET", path: domain, envelope: "domain" },
      updateDomain: { method: "PATCH", path: domain, envelope: "domain" },
      removeDomain: { method: "DELETE", path: domain, inputLocation: "query" },
      domainDependents: { method: "GET", path: (id, name) => `${domain(id, name)}/dependents` },
      getDomainDns: { method: "GET", path: (id, name) => `${domain(id, name)}/dns` },
      acknowledgeDomainDns: {
        method: "POST",
        path: (id, name) => `${domain(id, name)}/dns/acknowledge`,
      },
      planDomainDns: {
        method: "GET",
        path: (id, name) => `${domain(id, name)}/dns/plan`,
        envelope: "data",
      },
      applyDomainDns: {
        method: "POST",
        path: (id, name) => `${domain(id, name)}/dns/apply`,
        envelope: "data",
      },
    }),
    ...createRemoteChildResourceOperations(http, MailMailboxSchemas, {
      getMailbox: {
        method: "GET",
        path: mailbox,
        envelope: "mailbox",
        redactInvalidResponse: true,
      },
      updateMailbox: {
        method: "PATCH",
        path: mailbox,
        envelope: "mailbox",
        redactInvalidResponse: true,
      },
      removeMailbox: { method: "DELETE", path: mailbox, inputLocation: "query" },
    }),
    ...createRemoteChildResourceOperations(http, MailAliasSchemas, {
      updateAlias: { method: "PATCH", path: alias, envelope: "alias" },
      removeAlias: { method: "DELETE", path: alias },
    }),
    ...createRemoteChildResourceOperations(http, MailInboundSchemas, {
      updateInboundRule: { method: "PATCH", path: rule, envelope: "rule" },
      removeInboundRule: { method: "DELETE", path: rule },
    }),
    ...createRemoteChildResourceOperations(http, MailComponentSchemas, {
      componentLogs: { method: "GET", path: (id, key) => `${component(id, key)}/logs` },
      componentAction: {
        method: "POST",
        path: (id, key, input) => `${component(id, key)}/${(input as { action: string }).action}`,
        inputLocation: "path",
      },
    }),
    setup(input, options) {
      const body = JSON.stringify(parseInput(MailRequestSchemas.setup, input));
      return http.events("/mail/setup", { method: "POST", body, signal: options?.signal });
    },
  } satisfies MailOperations);
}
