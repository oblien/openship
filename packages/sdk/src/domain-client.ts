import {
  DomainCollectionSchemas, DomainResourceSchemas, DomainScopedSchemas,
  ResourceIdSchema, VerifyDomainInputSchema, parseInput, isRecord,
  type DomainOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

const domain = (id: string) => `/domains/${encodeURIComponent(id)}`;
export function createRemoteDomainOperations(http: HttpClient): DomainOperations {
  return Object.freeze({
    ...createRemoteResourceOperations(http, DomainCollectionSchemas, {
      list: { method: "GET", path: (id) => `/domains?projectId=${encodeURIComponent(id)}`, envelope: "data" },
      create: {
        method: "POST", path: () => "/domains",
        body: (id, input) => ({ ...(isRecord(input) ? input : {}), projectId: id }),
        response: (body) => isRecord(body) ? {
          domain: body.data, records: body.records,
          ...(body.www !== undefined && { www: body.www }),
          ...(body.wwwError !== undefined && { wwwError: body.wwwError }),
          ...(body.preexistingEdgeSite !== undefined && { preexistingEdgeSite: body.preexistingEdgeSite }),
        } : undefined,
      },
    }),
    ...createRemoteResourceOperations(http, DomainResourceSchemas, {
      get: { method: "GET", path: domain, envelope: "data" },
      remove: { method: "DELETE", path: domain },
      verify: { method: "POST", path: id => `${domain(id)}/verify`, inputLocation: "query", resultStatuses: [422] },
      records: { method: "GET", path: id => `${domain(id)}/records`, envelope: "data" },
      dnsPlan: { method: "GET", path: id => `${domain(id)}/dns/plan`, envelope: "data" },
      dnsApply: { method: "POST", path: id => `${domain(id)}/dns/apply`, inputLocation: "query", envelope: "data" },
      dnsChallenge: { method: "GET", path: id => `${domain(id)}/dns/challenge`, envelope: "data" },
      startDnsChallenge: { method: "POST", path: id => `${domain(id)}/dns/challenge`, envelope: "data" },
      checkDnsChallenge: { method: "POST", path: id => `${domain(id)}/dns/challenge/check`, envelope: "data" },
      cancelDnsChallenge: { method: "POST", path: id => `${domain(id)}/dns/challenge/cancel`, envelope: "data" },
      setPrimary: { method: "POST", path: id => `${domain(id)}/primary`, envelope: "data" },
      renewSsl: { method: "POST", path: id => `${domain(id)}/renew`, envelope: "data" },
      verifySsl: { method: "POST", path: id => `${domain(id)}/verify-ssl`, envelope: "data" },
      uploadCert: { method: "POST", path: id => `${domain(id)}/certificate`, envelope: "data" },
    }),
    ...createRemoteScopedOperations(http, DomainScopedSchemas, {
      preview: { method: "POST", path: () => "/domains/preview", envelope: "data" },
      renewAllSsl: { method: "POST", path: () => "/domains/renew-all", envelope: "data" },
      verifyPending: { method: "POST", path: () => "/domains/verify-pending", envelope: "data" },
    }),
    async *verifyStream(value, command = {}, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(VerifyDomainInputSchema, command);
      const url = http.url(`${domain(id)}/verify/stream`);
      if (input.force !== undefined) url.searchParams.set("force", String(input.force));
      yield* http.events(url.href, { method: "POST", signal: options.signal });
    },
  } satisfies DomainOperations);
}
