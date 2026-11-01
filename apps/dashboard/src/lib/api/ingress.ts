import { api } from "./client";
import type {
  IngressConnection,
  IngressConnectInput,
  IngressDiscovery,
  IngressUpdateInput,
  IngressDomainInput,
  IngressHostname,
} from "@repo/contracts";
export const ingressApi = {
  list: (serverId?: string) =>
    api.get<IngressConnection[]>(
      `dns/ingress${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ""}`,
    ),
  discover: (input: { credentialId: string; accountId?: string; includePolicies?: boolean }) =>
    api.post<IngressDiscovery>("dns/ingress/discover", input),
  connect: (input: IngressConnectInput) => api.post<IngressConnection>("dns/ingress", input),
  update: ({ id, ...body }: IngressUpdateInput) =>
    api.put<IngressConnection>(`dns/ingress/${encodeURIComponent(id)}`, body),
  retry: (id: string) =>
    api.post<IngressConnection>(`dns/ingress/${encodeURIComponent(id)}/retry`, {}),
  disconnect: (id: string) =>
    api.delete<{ success: true }>(`dns/ingress/${encodeURIComponent(id)}`),
  domain: (domainId: string) =>
    api.get<IngressHostname | null>(`dns/ingress/domains/${encodeURIComponent(domainId)}`),
  setDomain: ({ domainId, ...body }: IngressDomainInput) =>
    api.put<IngressHostname | null>(`dns/ingress/domains/${encodeURIComponent(domainId)}`, body),
};
