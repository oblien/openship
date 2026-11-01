import { z } from "zod";
import { valid, validRange, satisfies } from "semver";
import { INSPECTED_RUNTIMES, type InspectedRuntime } from "../stacks";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const range = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !!value.trim() && !!validRange(value));
const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
export const SECURITY_RUNTIMES = INSPECTED_RUNTIMES;
export type SecurityRuntime = InspectedRuntime;

export const SecurityAdvisorySchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().min(1).max(160),
    message: z.string().min(1).max(4000),
    severity: z.enum(["critical", "high", "moderate", "low"]),
    url: httpsUrl,
    publishedAt: z.string().datetime(),
    action: z.enum(["refresh-images", "manual"]),
    targets: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("image"),
              // Exact normalized repository, never a regex, URL or registry credential.
              repository: z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,254}$/),
              affectedDigests: z.array(digest).max(500).default([]),
              affectedTags: z
                .array(z.string().regex(/^[\w][\w.-]{0,127}$/))
                .max(100)
                .default([]),
              fixedDigests: z.array(digest).max(500).default([]),
            })
            .strict()
            .refine((value) => value.affectedDigests.length + value.affectedTags.length > 0),
          z
            .object({
              kind: z.literal("runtime"),
              runtime: z.enum(SECURITY_RUNTIMES),
              affected: range,
              fixed: range.nullable(),
            })
            .strict(),
          z.object({ kind: z.literal("platform"), affected: range }).strict(),
        ]),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine(
    (advisory) =>
      advisory.action === "manual" ||
      advisory.targets.every((target) => target.kind !== "runtime" || target.fixed !== null),
    "Runtime advisories without a known fixed range require manual review",
  );

export const SecurityManifestSchema = z
  .object({
    format: z.literal(1),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    advisories: z.array(SecurityAdvisorySchema).max(200),
  })
  .strict()
  .refine(
    (value) => new Set(value.advisories.map((item) => item.id)).size === value.advisories.length,
  );
export type SecurityManifest = z.infer<typeof SecurityManifestSchema>;
export type SecurityAdvisory = z.infer<typeof SecurityAdvisorySchema>;

export interface SecurityImageEvidence {
  serviceId: string | null;
  serviceName: string | null;
  role: "image" | "base";
  ref: string;
  digest: string | null;
}
export interface SecurityRuntimeEvidence {
  serviceId: string | null;
  runtime: SecurityRuntime;
  version: string;
}
export interface SecurityMatch {
  advisory: SecurityAdvisory;
  serviceId: string | null;
  evidence: string;
  confidence: "confirmed" | "possible";
  image: SecurityImageEvidence | null;
}

/** Docker Hub aliases all describe the same repository. Tags are never versions. */
export function securityImageIdentity(
  ref: string,
): { repository: string; tag: string | null } | null {
  if (!ref || /\s|:\/\//.test(ref)) return null;
  const unpinned = ref.split("@")[0]!;
  const colon = unpinned.lastIndexOf(":"),
    slash = unpinned.lastIndexOf("/");
  let repository = colon > slash ? unpinned.slice(0, colon) : unpinned;
  const tag = colon > slash ? unpinned.slice(colon + 1) : ref.includes("@") ? null : "latest";
  const first = repository.split("/")[0]!;
  if (
    !repository.includes("/") ||
    (!first.includes(".") && !first.includes(":") && first !== "localhost")
  )
    repository = `docker.io/${repository}`;
  repository = repository.replace(/^(index\.docker\.io|registry-1\.docker\.io)\//, "docker.io/");
  if (/^docker\.io\/[^/]+$/.test(repository))
    repository = repository.replace("docker.io/", "docker.io/library/");
  return { repository, tag };
}

/** Missing evidence stays unknown. A floating tag alone never proves a fixed runtime. */
export function matchSecurityAdvisories(
  manifest: SecurityManifest,
  images: SecurityImageEvidence[],
  runtimes: SecurityRuntimeEvidence[],
): SecurityMatch[] {
  const matches: SecurityMatch[] = [];
  for (const advisory of manifest.advisories)
    for (const target of advisory.targets) {
      if (target.kind === "image")
        for (const image of images) {
          const identity = securityImageIdentity(image.ref);
          if (
            !identity ||
            identity.repository !== securityImageIdentity(target.repository)?.repository
          )
            continue;
          if (image.digest && target.fixedDigests.includes(image.digest)) continue;
          const confirmed = !!image.digest && target.affectedDigests.includes(image.digest);
          if (confirmed || (identity.tag && target.affectedTags.includes(identity.tag)))
            matches.push({
              advisory,
              serviceId: image.serviceId,
              image,
              confidence: confirmed ? "confirmed" : "possible",
              evidence: `${image.ref}${image.digest ? ` (${image.digest})` : " (deployed digest unavailable)"}`,
            });
        }
      if (target.kind === "runtime")
        for (const runtime of runtimes) {
          if (runtime.runtime !== target.runtime || !valid(runtime.version)) continue;
          if (
            satisfies(runtime.version, target.affected) &&
            (!target.fixed || !satisfies(runtime.version, target.fixed))
          )
            matches.push({
              advisory,
              serviceId: runtime.serviceId,
              image: null,
              confidence: "confirmed",
              evidence: `${runtime.runtime} ${runtime.version}`,
            });
        }
    }
  return matches;
}

export function securitySigningBytes(payload: string): string {
  return `openship-security-advisories-v1\n${payload}`;
}

export const SECURITY_FEED_API =
  "https://api.github.com/repos/oblien/openship/contents/security-advisories.signed.json?ref=security-advisories";
export const SECURITY_FEED_SOURCE =
  "https://github.com/oblien/openship/blob/main/security-advisories.json";
