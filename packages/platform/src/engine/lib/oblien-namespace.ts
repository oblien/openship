import { AppError, type OblienLimits } from "@repo/core";
import { getOblienClient } from "./oblien-client";
import { ensureOblienDefaultQuota } from "../modules/billing/billing-oblien-quota";

/** Defaults apply only at creation. Oblien's ensure operation returns an existing
 * namespace without replacing its resource policy, usage or purchased credits. */
export async function ensureCloudNamespace(input: {
  name: string;
  slug: string;
  resource_limits: OblienLimits;
}): Promise<void> {
  await ensureOblienDefaultQuota();
  const ensured = await getOblienClient().namespaces.ensure(input);
  if (ensured.data.slug !== input.slug)
    throw new AppError("Cloud returned an unexpected namespace", 502, "CLOUD_NAMESPACE_MISMATCH");
}
