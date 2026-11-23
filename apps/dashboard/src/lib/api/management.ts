import type { BillingOperations } from "@repo/contracts";
import { api } from "./client";
import { invalidatePayments } from "@/lib/billing-events";
type Result<K extends keyof BillingOperations> = Awaited<ReturnType<BillingOperations[K]>>;
const post = async <K extends keyof BillingOperations>(path: string, body?: unknown) => {
  try { return (await api.post<{ data: Result<K> }>(`/billing/manage/${path}`, body)).data; }
  finally { invalidatePayments(); }
};
export const managementApi = {
  get: async () => (await api.get<{ data: Result<"getManagement"> }>("/billing/manage")).data,
  purchase: (input: Parameters<BillingOperations["purchaseManagement"]>[0]) =>
    post<"purchaseManagement">("checkout", input),
  confirm: (quoteId: string) => post<"confirmManagementChange">("change", { quoteId }),
  cancelChange: () => post<"cancelManagementChange">("change/cancel"),
  resumeCheckout: () => post<"resumeManagementCheckout">("checkout/resume"),
  cancelCheckout: () => post<"cancelManagementCheckout">("checkout/cancel"),
  cancel: () => post<"cancelManagementSubscription">("cancel"),
  resume: () => post<"resumeManagementSubscription">("resume"),
  portal: () => post<"createManagementPortal">("portal"),
};
