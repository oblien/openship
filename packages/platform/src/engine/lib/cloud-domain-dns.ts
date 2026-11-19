import type { Oblien } from "@repo/adapters";

/** The provider decides whether a parent proof covers this hostname. */
export async function checkCloudDomainDns(client: Pick<Oblien, "domain">, hostname: string) {
  const result = await client.domain.verify({ domain: hostname });
  const verified = result.verified && result.cname;
  const requiredRecords = {
    cname: result.cname ? undefined : result.required_records?.cname,
    txt: result.ownership === false && !result.enterprise ? result.required_records?.txt : undefined,
  };
  const missing = [
    requiredRecords.cname && `CNAME ${requiredRecords.cname.host} → ${requiredRecords.cname.target}`,
    requiredRecords.txt && `TXT ${requiredRecords.txt.host} = ${requiredRecords.txt.value}`,
  ].filter(Boolean);
  return {
    verified,
    cname: result.cname,
    ownership: result.ownership,
    requiredRecords,
    message: verified ? undefined : missing.length
      ? `Add ${missing.join(" and ")} to verify ${hostname}.`
      : result.errors?.join(". ") || `DNS is not configured for ${hostname}.`,
  };
}
