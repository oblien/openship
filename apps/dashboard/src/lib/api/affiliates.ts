import {
  AffiliateOperationSchemas,
  AffiliateRoutes,
  AffiliatePublicOfferSchema,
  parseInput,
  type AffiliateOperations,
} from "@repo/contracts";
import { api } from "./client";

export async function affiliateRequest<K extends keyof AffiliateOperations>(
  name: K,
  ...args: Parameters<AffiliateOperations[K]>
): Promise<Awaited<ReturnType<AffiliateOperations[K]>>> {
  const route = AffiliateRoutes[name],
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
  return parseInput(AffiliateOperationSchemas[name].output, response.data) as Awaited<
    ReturnType<AffiliateOperations[K]>
  >;
}
export async function getReferralOffer(code: string) {
  const result = await api.get<{ data: unknown }>(`referrals/${encodeURIComponent(code)}`);
  return parseInput(AffiliatePublicOfferSchema, result.data);
}
