import type {
  BillingPlanChange,
  MailPlanChangeQuote,
  MailChangeSelection,
  ManagedMailSummary,
  ManagedMailReceipt,
  ManagedTestEmailRequest,
  MailPlacement,
  MailProduct,
  PaidMailPlan,
  SendingDomainStatus,
  SendingIdentityKind,
  SendingUsageSnapshot,
} from "@repo/contracts";
import { api } from "./client";

const changePath = (target: string) =>
  "mail/managed/plans/" + encodeURIComponent(target) + "/change";

export const managedMailApi = {
  previewChange: (target: string, input: MailChangeSelection) =>
    api.post<MailPlanChangeQuote>(changePath(target) + "/preview", input),
  confirmChange: (target: string, quoteId: string) =>
    api.post<BillingPlanChange>(changePath(target), { quoteId, confirmRestart: true }),
  changeStatus: (target: string, changeId?: string) =>
    api.get<{ change: BillingPlanChange | null; pending: boolean }>(
      changePath(target) + (changeId ? "/" + encodeURIComponent(changeId) : ""),
    ),
  cancelChange: (target: string, changeId: string) =>
    api.post<BillingPlanChange>(changePath(target) + "/cancel", { changeId }),
  checkout: (
    plan: PaidMailPlan,
    product: MailProduct = "mailboxes",
    dedicated?: { storageGB: number; purchaseId: string; expectedMonthlyCents: number },
  ) => api.post<{ url: string }>("mail/managed/checkout", { plan, product, ...dedicated }),
  portal: () => api.post<{ url: string }>("mail/managed/portal"),
  cancelCheckout: () => api.post("mail/managed/checkout/cancel"),
  domains: () =>
    api.get<{ data: Array<{ domain: string; id: string; ownership: string; disabled: boolean }> }>(
      "mail/sending/domains",
    ),
  release: (id: string) => api.delete("mail/sending/domains/" + encodeURIComponent(id)),
  summary: () => api.get<ManagedMailSummary>("mail/managed"),
  service: (id: string) =>
    api.get<ManagedMailSummary>("mail/managed/services/" + encodeURIComponent(id)),
  order: (id: string, action: "resume" | "portal") =>
    api.post<{ url: string }>("mail/managed/services/" + encodeURIComponent(id) + "/" + action),
  cancelOrder: (id: string) =>
    api.post("mail/managed/services/" + encodeURIComponent(id) + "/cancel"),
  activate: (placement: MailPlacement, cloudServerId?: string) =>
    api.post<NonNullable<ManagedMailSummary["service"]>>("mail/managed", {
      placement,
      cloudServerId,
    }),
  cancelVmRequest: (id: string) =>
    api.delete("mail/managed/" + encodeURIComponent(id) + "/reservation"),
  domain: (domain: string) => api.post<SendingDomainStatus>("mail/sending/domains", { domain }),
  sender: (id: string) =>
    api.get<SendingDomainStatus>("mail/sending/domains/" + encodeURIComponent(id)),
  verify: (id: string) =>
    api.post<SendingDomainStatus>(`mail/sending/domains/${encodeURIComponent(id)}/verify`),
  testEmail: (id: string, input: ManagedTestEmailRequest) =>
    api.post<{ from: string; to: string; receipt: ManagedMailReceipt }>(
      `mail/sending/domains/${encodeURIComponent(id)}/test-email`, input),
  message: (id: string) => api.get<ManagedMailReceipt>("mail/sending/messages/" + encodeURIComponent(id)),
  webmailKey: (serverId: string, domain: string) =>
    api.get<{ sending: { apiOrigin?: string; keyId: string } | null }>(
      `mail/admin/${encodeURIComponent(serverId)}/webmail/sending/${encodeURIComponent(domain)}`),
  hostedSending: (serviceId: string, id: string) =>
    api.get<{ configured: boolean }>(`mail/managed/${encodeURIComponent(serviceId)}/sending/${encodeURIComponent(id)}`),
  connect: (serviceId: string, domainId: string) =>
    api.post(
      "mail/managed/" + encodeURIComponent(serviceId) + "/sending/" + encodeURIComponent(domainId),
    ),
  apiRelay: (serverId: string, id: string) =>
    api.get<{ keyId: string | null }>(`mail/managed/${encodeURIComponent(serverId)}/sending/${encodeURIComponent(id)}/api-relay`),
  enableApiRelay: (serverId: string, id: string) =>
    api.post(`mail/managed/${encodeURIComponent(serverId)}/sending/${encodeURIComponent(id)}/api-relay`),
  disableApiRelay: (serverId: string, id: string) =>
    api.delete(`mail/managed/${encodeURIComponent(serverId)}/sending/${encodeURIComponent(id)}/api-relay`),
  connectSmtp: (serverId: string, id: string) =>
    api.post<{ configured: true }>(`mail/managed/${encodeURIComponent(serverId)}/sending/${encodeURIComponent(id)}/smtp`),
  issueKey: (id: string) =>
    api.post<{ id: string; key: string }>(
      `mail/sending/domains/${encodeURIComponent(id)}/key`,
    ),
  keys: () =>
    api.get<{ data: Array<{ id: string; domainId: string | null; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; legacy?: boolean; smtp?: boolean }> }>("mail/sending/keys"),
  revoke: (id: string) => api.delete(`mail/sending/keys/${encodeURIComponent(id)}`),
  usage: () =>
    api.get<{ usedPeriod: number; reservedPeriod: number; policy: { period: number } }>(
      "mail/sending/usage",
    ),
  identityUsage: (kind: SendingIdentityKind) =>
    api.get<SendingUsageSnapshot>("mail/sending/usage/" + kind),
  setCap: (kind: SendingIdentityKind, identity: string, monthlyCap: number | null) =>
    api.put<{ success: true }>("mail/sending/caps/" + kind, { identity, monthlyCap }),
};
