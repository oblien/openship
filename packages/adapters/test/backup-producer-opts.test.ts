/**
 * The one boundary where a policy's free-form jsonb becomes typed producer options.
 *
 * Everything downstream of `sanitizeProducerOpts` reads `ProducerOpts` as if the
 * compiler had checked it. Nothing did: `payloadConfig` is jsonb, and the orchestrator
 * used to hand it over with a bare `as ProducerOpts` cast. So these tests are about a
 * declared type that was being asserted rather than established.
 *
 * The specific failure being pinned: an out-of-vocabulary `compression` made the
 * compressor lookup fall through to "apply nothing", so the artifact was written
 * UNCOMPRESSED while its metadata recorded the bogus name. The restore read that name
 * back through `recordedCodec`, which maps anything unknown to `zstd`, and piped a
 * plain tar through `zstd -d`. Capture green, bytes real, restore impossible forever.
 *
 * Two properties matter here and are tested as properties, not examples:
 *
 *   - It REPAIRS BY DELETION. Absent has always meant "probe the container, or use the
 *     producer's default" — the reading that cannot produce an artifact nobody can
 *     open. Substituting a default instead would silently pick a codec for the
 *     operator; deleting makes a garbage value indistinguishable from an unset one,
 *     which is what it always should have been.
 *
 *   - It FORWARDS EVERYTHING ELSE WHOLE. Hand-picking known keys here is exactly what
 *     once dropped every `custom_command` key and made each mail backup unrestorable,
 *     so this function is deliberately not a filter, a schema, or a reshaper.
 */

import { describe, expect, it } from "vitest";
import { PAYLOAD_COMPRESSION_CODECS } from "@repo/core";
import { sanitizeProducerOpts } from "../src/backup/common/producer-opts";

describe("sanitizeProducerOpts repairs the one field the producers trust blindly", () => {
  it("passes every codec in the vocabulary through untouched", () => {
    for (const codec of PAYLOAD_COMPRESSION_CODECS) {
      expect(sanitizeProducerOpts({ compression: codec }).compression, codec).toBe(codec);
    }
  });

  it("deletes an unknown codec rather than substituting a default", () => {
    for (const bad of ["brotli", "br", "zst", "gz", "xz", "ZSTD", "", "auto"]) {
      const opts = sanitizeProducerOpts({ compression: bad });
      expect(opts.compression, bad).toBeUndefined();
      // Deleted, not set to undefined: `"compression" in opts` is what a producer's
      // `opts.compression ?? probe()` reads the same either way, but an object that
      // still CARRIES the key serializes back into metadata as `null`, and that is a
      // third value the restore side has no reading for.
      expect(Object.prototype.hasOwnProperty.call(opts, "compression"), bad).toBe(false);
    }
  });

  it("deletes a non-string codec, so jsonb holding a number or object cannot pass", () => {
    for (const bad of [0, 1, true, false, {}, [], ["zstd"], { codec: "zstd" }, null]) {
      const opts = sanitizeProducerOpts({ compression: bad });
      expect(Object.prototype.hasOwnProperty.call(opts, "compression"), JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("makes a garbage value indistinguishable from an unset one", () => {
    // The whole point of repairing by deletion, stated as an equality: a policy
    // carrying `"brotli"` must reach the producers as the same options object a policy
    // that never named a codec reaches them with.
    expect(sanitizeProducerOpts({ paths: ["/data"], compression: "brotli" })).toEqual(
      sanitizeProducerOpts({ paths: ["/data"] }),
    );
  });

  it("forwards every other key whole, including ones it has never heard of", () => {
    // Not a filter. A key added by a newer build, or one only the custom-command
    // producer understands, has to survive an older sanitizer untouched — dropping
    // unknown keys is the shape of the defect that made mail backups unrestorable.
    const config = {
      paths: ["/var/www", "/data"],
      exclude: ["*.tmp"],
      sourceIds: ["vol-a"],
      quiesce: true,
      clearPath: false,
      produceCommand: "pg_dump -Fc",
      restoreCommand: "pg_restore -c",
      artifactName: "db.dump",
      somethingFromANewerBuild: { nested: [1, 2, 3] },
    };
    expect(sanitizeProducerOpts(config)).toEqual(config);
  });

  it("does not mutate the policy row it was handed", () => {
    // The orchestrator passes `policy.payloadConfig` straight in. Deleting the key off
    // that object would edit the in-memory policy — and the run record written later
    // from the same object would then claim the operator never set a codec.
    const config: Record<string, unknown> = { compression: "brotli", paths: ["/data"] };
    sanitizeProducerOpts(config);
    expect(config.compression).toBe("brotli");
  });

  it("answers empty options for a policy with no payloadConfig at all", () => {
    // Both spellings occur: the column is nullable, and a policy created before the
    // column existed reads back undefined through the repo's row mapper.
    expect(sanitizeProducerOpts(null)).toEqual({});
    expect(sanitizeProducerOpts(undefined)).toEqual({});
    expect(sanitizeProducerOpts({})).toEqual({});
  });

  it("leaves an absent codec absent", () => {
    const opts = sanitizeProducerOpts({ paths: ["/data"] });
    expect(Object.prototype.hasOwnProperty.call(opts, "compression")).toBe(false);
    // Explicit `undefined` is not a value either, and must not survive as a carried
    // key: the invariant is that `compression` is present iff it holds a buildable
    // codec, which is what lets every producer read `opts.compression ?? probe()`
    // without also asking whether the key was there.
    const explicit = sanitizeProducerOpts({ compression: undefined, paths: ["/data"] });
    expect(Object.prototype.hasOwnProperty.call(explicit, "compression")).toBe(false);
    expect(explicit).toEqual(sanitizeProducerOpts({ paths: ["/data"] }));
  });
});
