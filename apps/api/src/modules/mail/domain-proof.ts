import { resolveTxt } from "node:dns/promises";
import { managedMailDomainProof } from "@repo/contracts";
import { AppError } from "@repo/core";

export async function verifyMailDomainOwnership(serviceId: string, domain: string) {
  const { name, value } = managedMailDomainProof(serviceId, domain);
  const records = await resolveTxt(name).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENODATA" || e.code === "ENOTFOUND") return [];
    throw new AppError("DNS lookup is temporarily unavailable. Retry verification.", 503);
  });
  if (!records.some((chunks) => chunks.join("") === value))
    throw new AppError(
      `Add TXT ${name} with value ${value}, then try again.`,
      409,
      "MAIL_DNS_PROOF_REQUIRED",
    );
}
