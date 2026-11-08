import {
  ReferralOperationSchemas,
  ReferralRoutes,
  ReferralPublicOfferSchema,
  parseInput,
  type ReferralOperations,
} from "@repo/contracts";
import { api } from "./client";

export async function referralRequest<K extends keyof ReferralOperations>(
  name: K,
  ...args: Parameters<ReferralOperations[K]>
): Promise<Awaited<ReturnType<ReferralOperations[K]>>> {
  const route = ReferralRoutes[name],
    input = args[0] ?? {};
  const query = new URLSearchParams(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  const path = route.path.slice(1);
  const response =
    route.method === "GET"
      ? await api.get<{ data: unknown }>(`${path}${query.size ? `?${query}` : ""}`)
      : await api.post<{ data: unknown }>(path, input);
  return parseInput(ReferralOperationSchemas[name].output, response.data) as Awaited<
    ReturnType<ReferralOperations[K]>
  >;
}
export async function getReferralOffer(code: string) {
  const result = await api.get<{ data: unknown }>(`referrals/${encodeURIComponent(code)}`);
  return parseInput(ReferralPublicOfferSchema, result.data);
}
