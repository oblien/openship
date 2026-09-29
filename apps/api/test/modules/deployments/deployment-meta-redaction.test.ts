/**
 * A frozen compose snapshot must keep the credentials a rollback replays.
 *
 * `deployment.meta` rides into jsonb through the BUILD-LOG scrubber, and that
 * scrubber rewrites URL userinfo to `***@` (`redactCredentials`). For a log line
 * that is right. For `meta.composeServices` — the frozen env of every compose
 * service — it is a break, in the same shape as the backup `restoreCommand` bug:
 * the field is an encrypted operational record that a rollback replays VERBATIM,
 * and `syncFromCompose` writes it onto the live service rows, which is what
 * actually builds the container.
 *
 * So a `DATABASE_URL=postgresql://app:secret@db:5432/app` was frozen as
 * `postgresql://***@db:5432/app`, and rolling that release back rebuilt the exact
 * breakage the rollback was meant to undo — the app crash-looped on
 * `no password supplied` while the rollback itself reported success.
 *
 * The redaction protected nothing here either: `sealDeploymentMeta` encrypts the
 * same field, which is a stronger guarantee than a `***` that breaks the restore.
 */

import { describe, expect, it } from "vitest";
import { DEPLOYMENT_SECRET_FIELDS } from "@repo/db/configuration-secrets";

import {
  sanitizeDeploymentMeta,
  sanitizeStorableStrings,
  storableTextPreservingSecrets,
} from "@repo/platform/engine/modules/deployments/build-log-sanitize";
import {
  hasRedactedFrozenEnv,
  isRedactedUserinfo,
  replaceRedactedFrozenEnv,
} from "@repo/platform/engine/modules/deployments/compose/redacted-frozen-env";

const DSN = "postgresql://app:s3cr3t@db:5432/app";
const REDACTED_DSN = "postgresql://***@db:5432/app";
const GITHUB_CLONE = "https://x-access-token:ghs_AAAAAAAAAAAAAAAA@github.com/owner/repo.git";
const REDACTED_CLONE = "https://***@github.com/owner/repo.git";

/** Built rather than typed, so no editor or copy step can lose them. */
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const ROCKET = String.fromCodePoint(0x1f680);

/** The shape `sealDeploymentMeta` encrypts: compose services under `meta`. */
function meta() {
  return {
    branch: "main",
    releaseVersion: "v1.2.3",
    composeServices: [
      {
        name: "app",
        image: "app:bld_1",
        environment: { DATABASE_URL: DSN, APP_ENV: "production" },
      },
      {
        name: "db",
        image: "postgres:16-alpine",
        environment: { POSTGRES_PASSWORD: "s3cr3t" },
      },
    ],
  };
}

describe("a deployment meta write keeps the credentials a rollback replays", () => {
  it("stores the DSN verbatim", () => {
    const stored = sanitizeDeploymentMeta(meta());
    expect(stored.composeServices[0].environment.DATABASE_URL).toBe(DSN);
    // A secret with no URL shape is untouched by the redactor either way, but
    // the whole field must reach storage, not just its credential-bearing keys.
    expect(stored.composeServices[1].environment.POSTGRES_PASSWORD).toBe("s3cr3t");
  });

  it("is what the old path got wrong, so the regression is visible here", () => {
    // The unmodified scrubber, for contrast: same input, unrestorable output.
    const scrubbed = sanitizeStorableStrings(meta());
    const dsn = scrubbed.composeServices[0].environment.DATABASE_URL;
    expect(dsn).toBe(REDACTED_DSN);
    expect(dsn).not.toContain("s3cr3t");
    // And nothing downstream could tell — it is still a plausible DSN.
    expect(dsn).toMatch(/^postgresql:\/\//);
  });

  it("still redacts the credential the pipeline itself embeds in a command", () => {
    // The exemption is scoped to the encrypted field. Elsewhere in the same blob
    // the scrubber is the thing standing between a build log and a private repo.
    const stored = sanitizeDeploymentMeta({
      composeDeployment: { cloneUrl: GITHUB_CLONE },
      composeServices: meta().composeServices,
    });
    expect(stored.composeDeployment.cloneUrl).toBe(REDACTED_CLONE);
    expect(stored.composeServices[0].environment.DATABASE_URL).toBe(DSN);
  });

  it("still scrubs other meta fields that are log text, not records", () => {
    const stored = sanitizeDeploymentMeta({
      deployWarning: `build step failed cloning ${GITHUB_CLONE}`,
      composeServices: meta().composeServices,
    });
    expect(stored.deployWarning).not.toContain("ghs_AAAAAAAAAAAAAAAA");
  });

  it("exempts the whole subtree under composeServices, not just its leaves", () => {
    const stored = sanitizeDeploymentMeta({
      composeServices: [{ name: "app", advanced: { inlineFiles: { ".env": DSN } } }],
    });
    expect(stored.composeServices[0].advanced.inlineFiles[".env"]).toBe(DSN);
  });

  it("exempts exactly the fields the storage codec seals", () => {
    // The invariant, pinned: whatever `sealDeploymentMeta` ENCRYPTS must be a
    // field this write path leaves intact. `DEPLOYMENT_SECRET_FIELDS` grows, and
    // a field that is encrypted on the way in but scrubbed on the way out is a
    // rollback replaying a destroyed value.
    for (const field of DEPLOYMENT_SECRET_FIELDS) {
      const stored = sanitizeDeploymentMeta({ [field]: [{ name: "app", value: DSN }] });
      expect((stored as Record<string, Array<{ value: string }>>)[field][0].value).toBe(DSN);
    }
  });
});

describe("preserving credentials does not give up storability", () => {
  it("still drops a NUL and repairs a lone surrogate", () => {
    // Both are FATAL at the column: Postgres rejects the NUL byte in a text
    // column outright and the lone surrogate in jsonb. A compose env value
    // assembled from interpolation can carry either, and this write also carries
    // the deployment's terminal status.
    const stored = sanitizeDeploymentMeta({
      composeServices: [{ name: "app", environment: { DSN: `${DSN} ${NUL} ${LONE_SURROGATE}` } }],
    });
    const dsn = stored.composeServices[0].environment.DSN;
    expect(dsn).not.toContain(NUL);
    expect(dsn).not.toMatch(/[\uD800-\uDFFF]/);
    expect(dsn).toContain("s3cr3t@db:5432");
  });

  it("keeps a valid surrogate PAIR intact", () => {
    const stored = sanitizeDeploymentMeta({
      composeServices: [{ name: "app", environment: { BANNER: `hi ${ROCKET}` } }],
    });
    expect(stored.composeServices[0].environment.BANNER).toBe(`hi ${ROCKET}`);
  });

  it("differs from the scrubber ONLY in the redaction", () => {
    // A meta with no preserved subtree must be byte-identical to the old path.
    expect(sanitizeDeploymentMeta({ deployWarning: "ok" })).toEqual(
      sanitizeStorableStrings({ deployWarning: "ok" }),
    );
    // And the exempt half of a value is still length-capped like any other.
    const long = `${"x".repeat(32768 - 1)}${ROCKET} tail`;
    const stored = sanitizeDeploymentMeta({
      composeServices: [{ name: "a", environment: { K: long } }],
    });
    expect(stored.composeServices[0].environment.K).toContain("truncated for storage");
  });

  it("matches the shared preserving-secrets primitive on a preserved leaf", () => {
    // The exemption routes through `storableTextPreservingSecrets`, not a new
    // pass — one implementation, so the two cannot drift.
    expect(storableTextPreservingSecrets(DSN)).toBe(DSN);
  });
});

describe("a snapshot frozen before the fix still restores", () => {
  const live = new Map([
    ["app", { DATABASE_URL: DSN, APP_ENV: "production" }],
    ["db", { POSTGRES_PASSWORD: "s3cr3t" }],
  ]);

  it("recognises only the scrubber's own shape", () => {
    expect(isRedactedUserinfo(REDACTED_DSN)).toBe(true);
    expect(isRedactedUserinfo(REDACTED_CLONE)).toBe(true);
    expect(isRedactedUserinfo(DSN)).toBe(false);
    // A bare `***` in a real value must not be read as scrubber output — an
    // operator's own banner is not a redacted credential.
    expect(isRedactedUserinfo("echo '*** ok ***'")).toBe(false);
    expect(isRedactedUserinfo(undefined)).toBe(false);
    expect(isRedactedUserinfo(null)).toBe(false);
  });

  it("takes the live value for a redacted key, and the frozen value for the rest", () => {
    const restored = replaceRedactedFrozenEnv(
      [
        {
          name: "app",
          environment: { DATABASE_URL: REDACTED_DSN, APP_ENV: "staging" },
        },
      ],
      live,
    );
    expect(restored[0].environment.DATABASE_URL).toBe(DSN);
    // Only the mangled key is replaced. The frozen value is still the record.
    expect(restored[0].environment.APP_ENV).toBe("staging");
  });

  it("leaves an intact snapshot alone, by reference", () => {
    const frozen = [{ name: "app", environment: { DATABASE_URL: DSN } }] as const;
    expect(replaceRedactedFrozenEnv(frozen, live)).toBe(frozen);
  });

  it("keeps a redacted value the live row cannot supply", () => {
    // No live counterpart means no value to substitute. Dropping the key would
    // silently unset a variable the container needs; keeping `***` is the
    // honest outcome, and the deploy log is where it surfaces.
    const restored = replaceRedactedFrozenEnv(
      [{ name: "worker", environment: { DATABASE_URL: REDACTED_DSN } }],
      live,
    );
    expect(restored[0].environment.DATABASE_URL).toBe(REDACTED_DSN);
  });

  it("passes monorepo sub-apps through untouched", () => {
    // Their env is applied from the live rows, not from the frozen snapshot, so
    // rewriting it here would change nothing that ships.
    const frozen = [{ name: "web", kind: "monorepo" as const, environment: { URL: REDACTED_DSN } }];
    expect(replaceRedactedFrozenEnv(frozen, live)).toBe(frozen);
  });

  it("tolerates a snapshot or a live map that is missing", () => {
    expect(replaceRedactedFrozenEnv(undefined, live)).toEqual([]);
    expect(
      replaceRedactedFrozenEnv(
        [{ name: "app", environment: { DATABASE_URL: REDACTED_DSN } }],
        new Map(),
      ),
    ).toEqual([{ name: "app", environment: { DATABASE_URL: REDACTED_DSN } }]);
  });

  it("only claims a repair is needed when something is actually mangled", () => {
    // This is the gate the rollback path uses to skip its live-row read, so it
    // has to agree with `replaceRedactedFrozenEnv` on every input — a false
    // negative here silently replays `***`, and a false positive costs a query
    // on every restore.
    expect(hasRedactedFrozenEnv(meta().composeServices)).toBe(false);
    expect(
      hasRedactedFrozenEnv([{ name: "app", environment: { DATABASE_URL: REDACTED_DSN } }]),
    ).toBe(true);
    // A monorepo entry is applied from the live rows, not the snapshot, so it is
    // not this path's business.
    expect(
      hasRedactedFrozenEnv([{ name: "web", kind: "monorepo", environment: { URL: REDACTED_DSN } }]),
    ).toBe(false);
    expect(hasRedactedFrozenEnv(undefined)).toBe(false);
    expect(hasRedactedFrozenEnv([])).toBe(false);
    expect(hasRedactedFrozenEnv([{ name: "app" }])).toBe(false);
  });
});
