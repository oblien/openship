import { createPlatform, type CloudRuntime } from "@repo/adapters";
import { SYSTEM } from "@repo/core";
import { issueNamespaceToken } from "./openship-cloud";

export interface CloudPreflightData {
  runtime: { ok: boolean; message?: string };
  slug?: { available: boolean; message?: string };
  customDomain?: { verified: boolean; message?: string };
}

export async function runCloudPreflight(
  userId: string,
  opts: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData> {
  try {
    const token = await issueNamespaceToken(userId);
    const cloudPlatform = await createPlatform({ target: "cloud", cloudToken: token.token });
    const cloud = cloudPlatform.runtime as CloudRuntime;

    await cloud.getQuota();

    const result: CloudPreflightData = {
      runtime: { ok: true },
    };

    if (opts.slug) {
      try {
        const slug = await cloud.checkSlug(opts.slug);
        result.slug = slug.available
          ? { available: true }
          : {
              available: false,
              message: `"${opts.slug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}" is already taken. Choose a different subdomain.`,
            };
      } catch {
        result.slug = { available: true, message: "Could not verify subdomain availability" };
      }
    }

    if (opts.customDomain) {
      try {
        const verified = await cloud.verifyDomain(opts.customDomain);
        result.customDomain = verified.verified
          ? { verified: true }
          : {
              verified: false,
              message: verified.errors.length > 0
                ? verified.errors.join("; ")
                : `DNS not configured for ${opts.customDomain}. Add a CNAME record pointing to ${verified.requiredRecords.cname.target}`,
            };
      } catch {
        result.customDomain = { verified: true, message: "Could not verify custom domain with cloud runtime" };
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      runtime: { ok: false, message: `Cannot connect to cloud runtime: ${message}` },
      slug: opts.slug ? { available: true, message: "Could not verify subdomain availability" } : undefined,
      customDomain: opts.customDomain ? { verified: true, message: "Could not verify custom domain with cloud runtime" } : undefined,
    };
  }
}