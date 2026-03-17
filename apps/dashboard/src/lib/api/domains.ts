import { api } from "./client";
import { endpoints } from "./endpoints";

export const domainsApi = {
  /** Get DNS records preview for a hostname (no domain creation needed). */
  previewRecords: (hostname: string) =>
    api.post<{
      data: {
        mode: "cloud" | "selfhosted";
        records: Array<{ type: "CNAME" | "A" | "TXT"; host: string; value: string }>;
      };
    }>(endpoints.domains.preview, { hostname }),
};
