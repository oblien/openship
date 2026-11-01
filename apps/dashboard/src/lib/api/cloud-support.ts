import {
  CLOUD_SUPPORT_ACCOUNT_HEADER,
  CloudSupportSessionSchema,
  CloudSupportReceiptSchema,
  parseInput,
  CloudSupportCustomerListSchema,
  CloudSupportCustomerDetailSchema,
  type CloudSupportCustomerInput,
  type CloudSupportCustomerReply,
  type CloudSupportCustomerQuery,
} from "@repo/contracts";
import { api, getApiErrorCode } from "./client";

const customerPath = "cloud/support/mine";
const ticketPath = (id: string) => `${customerPath}/${encodeURIComponent(id)}`;

/** Account-private reads must not reuse a request started under an earlier session. */
export function createCloudSupportApi(accountKey?: string, onAccountChanged?: () => void) {
  const options = {
    headers: accountKey ? { [CLOUD_SUPPORT_ACCOUNT_HEADER]: accountKey } : undefined,
  };
  async function checked<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (error) {
      if (
        [
          "SUPPORT_ACCOUNT_CHANGED",
          "SUPPORT_CLOUD_SESSION_REQUIRED",
          "SUPPORT_SESSION_REQUIRED",
        ].includes(getApiErrorCode(error) ?? "")
      )
        onAccountChanged?.();
      throw error;
    }
  }
  return {
    async list(input: Partial<CloudSupportCustomerQuery> = {}) {
      return parseInput(
        CloudSupportCustomerListSchema,
        await checked(
          api.get<unknown>(customerPath, {
            ...options,
            dedupe: false,
            cache: "no-store",
            params: { limit: 25, ...input },
          }),
        ),
      );
    },
    async create(input: CloudSupportCustomerInput) {
      return parseInput(
        CloudSupportReceiptSchema,
        await checked(api.post<unknown>(customerPath, input, options)),
      );
    },
    async get(id: string) {
      return parseInput(
        CloudSupportCustomerDetailSchema,
        await checked(
          api.get<unknown>(ticketPath(id), { ...options, dedupe: false, cache: "no-store" }),
        ),
      );
    },
    async reply(id: string, input: CloudSupportCustomerReply) {
      return parseInput(
        CloudSupportCustomerDetailSchema,
        await checked(api.post<unknown>(`${ticketPath(id)}/replies`, input, options)),
      );
    },
    async setStatus(id: string, status: "open" | "resolved") {
      return parseInput(
        CloudSupportCustomerDetailSchema,
        await checked(api.patch<unknown>(ticketPath(id), { status }, options)),
      );
    },
  };
}

export type CloudSupportApi = ReturnType<typeof createCloudSupportApi>;

export async function getCloudSupportSession() {
  return parseInput(
    CloudSupportSessionSchema,
    await api.get<unknown>("cloud/support/session", {
      dedupe: false,
      cache: "no-store",
    }),
  );
}
