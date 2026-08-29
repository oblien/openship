/**
 * A backup artifact's recorded command must survive storage VERBATIM.
 *
 * The recorded `restoreCommand` is the only record of how to put a `custom_command`
 * artifact back: `CustomCommandProducer.restore` reads it off the run's metadata and
 * executes it. That metadata used to go into jsonb through the build-log scrubber,
 * which rewrites a URL's userinfo to `***@` — so a policy whose restore is
 * `mongorestore --uri "mongodb://root:pw@db/?authSource=admin"` was stored as
 * `mongodb://***@db/...`.
 *
 * That failed in the worst available way. The command was PRESENT, so the boot audit
 * (which looked for an EMPTY one) never flagged it; the run showed as a restore point
 * for months; and the restore then died on authentication partway through — after the
 * artifact had already been streamed. Meanwhile the real command was written
 * unredacted into the destination's own manifest.json, the copy that actually leaves
 * the box, and it sits unredacted on the policy row. So the redaction removed the
 * secret from nowhere and cost the restore.
 *
 * Storability is the half that must NOT be dropped: Postgres refuses a NUL in a text
 * column and a lone surrogate in jsonb, and this value shares its write with the run's
 * terminal status — an unstorable byte there loses the OUTCOME, not a message.
 */

import { describe, expect, it } from "vitest";
import { isRedactedCommand, PRESERVED_ARTIFACT_METADATA_KEYS } from "@repo/adapters";
import {
  MAX_ENTRY_CHARS,
  sanitizeLogText,
  sanitizeStorableStrings,
  sanitizeStorableStringsExceptKeys,
  storableTextPreservingSecrets,
} from "../../../src/modules/deployments/build-log-sanitize";

const MONGO_URI = "mongodb://root:s3cr3t@db:27017/?authSource=admin";
const MONGO_RESTORE = `mongorestore --uri "${MONGO_URI}" --archive`;
const MONGO_DUMP = `mongodump --uri "${MONGO_URI}" --archive`;

/** Built rather than typed, so no editor or copy step can lose them. */
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const ROCKET = String.fromCodePoint(0x1f680);

/** The shape the orchestrator stores: producer artifacts with metadata. */
function artifacts() {
  return [
    {
      name: "custom-backup.bin",
      key: "prj/svc/run/custom-backup.bin",
      sizeBytes: 4096,
      sha256: "deadbeef",
      payloadKind: "custom_command",
      metadata: { produceCommand: MONGO_DUMP, restoreCommand: MONGO_RESTORE },
    },
  ];
}

describe("recorded backup commands are not credential-scrubbed", () => {
  it("keeps the DSN password in restoreCommand", () => {
    const [stored] = sanitizeStorableStringsExceptKeys(
      artifacts(),
      PRESERVED_ARTIFACT_METADATA_KEYS,
    );
    expect(stored!.metadata.restoreCommand).toBe(MONGO_RESTORE);
    // The provenance half too — a hand-restore reads both.
    expect(stored!.metadata.produceCommand).toContain("s3cr3t");
  });

  it("is what the old path got wrong, so the regression is visible here", () => {
    // The unmodified scrubber, for contrast: same input, unrestorable output.
    const [scrubbed] = sanitizeStorableStrings(artifacts());
    const command = scrubbed!.metadata.restoreCommand;
    expect(command).not.toContain("s3cr3t");
    expect(command).toContain("://***@");
    // And nothing downstream could tell: it is still a non-empty string, which is all
    // the boot audit and the producer's own guard ever checked.
    expect(command.trim()).not.toBe("");
  });

  it("still scrubs metadata that is NOT a command", () => {
    const [stored] = sanitizeStorableStringsExceptKeys(
      [
        {
          metadata: {
            restoreCommand: MONGO_RESTORE,
            // A producer's captured stderr tail: log text, so it gets no exemption.
            lastError: "fatal: could not read https://x-access-token:ghs_AAAAAAAAAAAAAAAA@h/r",
          },
        },
      ],
      PRESERVED_ARTIFACT_METADATA_KEYS,
    );
    expect(stored!.metadata.restoreCommand).toContain("s3cr3t");
    expect(stored!.metadata.lastError).not.toContain("ghs_AAAAAAAAAAAAAAAA");
  });

  it("exempts the whole subtree under a preserved key, not just its leaf", () => {
    const stored = sanitizeStorableStringsExceptKeys(
      { command: { pre: ["psql postgres://u:pw@h/db"] } },
      PRESERVED_ARTIFACT_METADATA_KEYS,
    );
    expect(stored.command.pre[0]).toContain("pw@h");
  });
});

describe("preserving credentials does not give up storability", () => {
  it("still drops a NUL and repairs a lone surrogate", () => {
    // Both are FATAL at the column: Postgres rejects the NUL byte in a text column
    // outright and the lone surrogate in jsonb. A command assembled from remote output
    // can carry either, and this write also carries the run's terminal status.
    const out = storableTextPreservingSecrets(
      `psql postgres://u:pw@h/db ${NUL} ${LONE_SURROGATE} done`,
    );
    expect(out).not.toContain(NUL);
    expect(out).not.toMatch(/[\uD800-\uDFFF]/);
    expect(out).toContain("pw@h");
  });

  it("keeps a valid surrogate PAIR intact", () => {
    expect(storableTextPreservingSecrets(`echo ${ROCKET}`)).toBe(`echo ${ROCKET}`);
  });

  it("caps an absurd command without leaving a split pair behind", () => {
    const long = `${"x".repeat(MAX_ENTRY_CHARS - 1)}${ROCKET} tail`;
    const out = storableTextPreservingSecrets(long);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(out).toContain("truncated for storage");
  });

  it("differs from sanitizeLogText ONLY in the redaction", () => {
    const plain = "psql -d app -f -";
    expect(storableTextPreservingSecrets(plain)).toBe(sanitizeLogText(plain));
  });
});

describe("a command already scrubbed on disk is recognisable", () => {
  it("matches the shape the scrubber manufactures", () => {
    expect(isRedactedCommand(sanitizeLogText(MONGO_RESTORE))).toBe(true);
  });

  it("does not condemn a real command that merely contains ***", () => {
    // The reason the marker is `://***@` and not a bare `***`: an operator's own banner
    // must not be reported as an unrestorable backup.
    expect(isRedactedCommand("echo '*** restoring ***'; psql -f -")).toBe(false);
    expect(isRedactedCommand(MONGO_RESTORE)).toBe(false);
  });
});
